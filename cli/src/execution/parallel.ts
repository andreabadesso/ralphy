import { copyFileSync, cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { PROGRESS_FILE, RALPHY_DIR } from "../config/loader.ts";
import { logTaskProgress } from "../config/writer.ts";
import { detectStepFromOutput } from "../engines/base.ts";
import type { AIEngine, AIResult } from "../engines/types.ts";
import { getCurrentBranch, returnToBaseBranch } from "../git/branch.ts";
import {
	abortMerge,
	createIntegrationBranch,
	deleteLocalBranch,
	mergeAgentBranch,
} from "../git/merge.ts";
import { cleanupAgentWorktree, createAgentWorktree, getWorktreeBase } from "../git/worktree.ts";
import type { Task, TaskSource } from "../tasks/types.ts";
import { YamlTaskSource } from "../tasks/yaml.ts";
import { logDebug, logError, logInfo, logSuccess, logWarn } from "../ui/logger.ts";
import { notifyTaskComplete, notifyTaskFailed } from "../ui/notify.ts";
import { resolveConflictsWithAI } from "./conflict-resolution.ts";
import { buildParallelPrompt } from "./prompt.ts";
import { isRetryableError, sleep, withRetry } from "./retry.ts";
import type { ExecutionOptions, ExecutionResult } from "./sequential.ts";
import { updateState, removeAgentFromState, updateSummary } from "./state.ts";

interface ParallelAgentResult {
	task: Task;
	worktreeDir: string;
	branchName: string;
	result: AIResult | null;
	error?: string;
}

/**
 * Run a single agent in a worktree
 */
async function runAgentInWorktree(
	engine: AIEngine,
	task: Task,
	agentNum: number,
	baseBranch: string,
	worktreeBase: string,
	originalDir: string,
	prdSource: string,
	prdFile: string,
	prdIsFolder: boolean,
	maxRetries: number,
	retryDelay: number,
	skipTests: boolean,
	skipLint: boolean,
	browserEnabled: "auto" | "true" | "false",
	modelOverride?: string,
	tmux?: boolean,
): Promise<ParallelAgentResult> {
	let worktreeDir = "";
	let branchName = "";
	const agentId = agentNum.toString();

	try {
		updateState(agentId, { task: task.title, status: "pending", step: "Creating worktree" }, originalDir);
		
		// Create worktree
		const worktree = await createAgentWorktree(
			task.title,
			agentNum,
			baseBranch,
			worktreeBase,
			originalDir,
		);
		worktreeDir = worktree.worktreeDir;
		branchName = worktree.branchName;

		logDebug(`Agent ${agentNum}: Created worktree at ${worktreeDir}`);
		updateState(agentId, { worktreeDir, branchName, step: "Preparing worktree" }, originalDir);

		// Copy PRD file or folder to worktree
		if (prdSource === "markdown" || prdSource === "yaml") {
			const srcPath = join(originalDir, prdFile);
			const destPath = join(worktreeDir, prdFile);
			if (existsSync(srcPath)) {
				const destDir = dirname(destPath);
				if (!existsSync(destDir)) {
					mkdirSync(destDir, { recursive: true });
				}
				copyFileSync(srcPath, destPath);
			}
		} else if (prdSource === "markdown-folder" && prdIsFolder) {
			const srcPath = join(originalDir, prdFile);
			const destPath = join(worktreeDir, prdFile);
			if (existsSync(srcPath)) {
				const destDir = dirname(destPath);
				if (!existsSync(destDir)) {
					mkdirSync(destDir, { recursive: true });
				}
				cpSync(srcPath, destPath, { recursive: true });
			}
		}

		// Ensure .ralphy/ exists in worktree
		const ralphyDir = join(worktreeDir, RALPHY_DIR);
		if (!existsSync(ralphyDir)) {
			mkdirSync(ralphyDir, { recursive: true });
		}

		// Build prompt
		const prompt = buildParallelPrompt({
			task: task.title,
			progressFile: PROGRESS_FILE,
			skipTests,
			skipLint,
			browserEnabled,
		});

		// Execute with retry
		const taskSlug = task.title.replace(/[^a-zA-Z0-9-]/g, "-").toLowerCase();
		const engineOptions = { 
			modelOverride,
			tmux,
			agentId,
			taskSlug,
			onProgress: (line: string) => {
				const step = detectStepFromOutput(line);
				if (step) {
					updateState(agentId, { step }, originalDir);
				}
			}
		};

		if (tmux) {
			const sessionName = `ralphy-${agentId}-${taskSlug}`.replace(/[^a-zA-Z0-9-]/g, "-").toLowerCase();
			updateState(agentId, { tmuxSession: sessionName, status: "running", step: "Executing (tmux)" }, originalDir);
			logInfo(`Agent ${agentNum} (${task.title}) running in tmux: tmux attach -t ${sessionName}`);
		} else {
			updateState(agentId, { status: "running", step: "Executing" }, originalDir);
		}

		const result = await withRetry(
			async () => {
				const res = await engine.execute(prompt, worktreeDir, engineOptions);
				if (!res.success && res.error && isRetryableError(res.error)) {
					throw new Error(res.error);
				}
				return res;
			},
			{ maxRetries, retryDelay },
		);

		if (result.success) {
			updateState(agentId, { status: "completed", step: "Finished" }, originalDir);
		} else {
			updateState(agentId, { status: "failed", step: "Failed", error: result.error }, originalDir);
		}

		return { task, worktreeDir, branchName, result };
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		updateState(agentId, { status: "failed", step: "Error", error: errorMsg }, originalDir);
		return { task, worktreeDir, branchName, result: null, error: errorMsg };
	}
}

/**
 * Run tasks in parallel using worktrees
 */
export async function runParallel(
	options: ExecutionOptions & {
		maxParallel: number;
		prdSource: string;
		prdFile: string;
		prdIsFolder?: boolean;
	},
): Promise<ExecutionResult> {
	const {
		engine,
		taskSource,
		workDir,
		skipTests,
		skipLint,
		dryRun,
		maxIterations,
		maxRetries,
		retryDelay,
		baseBranch,
		maxParallel,
		prdSource,
		prdFile,
		prdIsFolder = false,
		browserEnabled,
		modelOverride,
		skipMerge,
		tmux,
	} = options;

	const result: ExecutionResult = {
		tasksCompleted: 0,
		tasksFailed: 0,
		totalInputTokens: 0,
		totalOutputTokens: 0,
	};

	// Get worktree base directory
	const worktreeBase = getWorktreeBase(workDir);
	logDebug(`Worktree base: ${worktreeBase}`);

	// Save starting branch to restore after merge phase
	const startingBranch = await getCurrentBranch(workDir);

	// Save original base branch for merge phase
	const originalBaseBranch = baseBranch || startingBranch;

	// Track completed branches for merge phase
	const completedBranches: string[] = [];

	// Global agent counter to ensure unique numbering across batches
	let globalAgentNum = 0;

	// Track tasks that failed to avoid infinite loops
	const failedTaskIds = new Set<string>();

	// Process tasks in batches
	let iteration = 0;

	while (true) {
		// Check iteration limit
		if (maxIterations > 0 && iteration >= maxIterations) {
			logInfo(`Reached max iterations (${maxIterations})`);
			break;
		}

		// Get tasks for this batch
		let allTasks: Task[] = [];

		// For YAML sources, try to get tasks from the same parallel group
		if (taskSource instanceof YamlTaskSource) {
			const nextTask = await taskSource.getNextTask();
			if (!nextTask) break;

			const group = await taskSource.getParallelGroup(nextTask.title);
			if (group > 0) {
				allTasks = await taskSource.getTasksInGroup(group);
			} else {
				allTasks = [nextTask];
			}
		} else {
			// For other sources, get all remaining tasks
			allTasks = await taskSource.getAllTasks();
		}

		// Filter out tasks that already failed in this session
		const tasks = allTasks.filter(t => !failedTaskIds.has(t.id));

		if (tasks.length === 0) {
			if (allTasks.length > 0) {
				logWarn(`Some tasks (${allTasks.length}) are still pending but have failed before. Stopping to avoid infinite loop.`);
			} else {
				logSuccess("All tasks completed!");
			}
			break;
		}

		// Update summary with total tasks if this is the first iteration
		if (iteration === 0) {
			const allTasksCount = await taskSource.countRemaining();
			updateSummary({ total: allTasksCount }, workDir);
		}

		// Limit to maxParallel
		const batch = tasks.slice(0, maxParallel);
		iteration++;

		logInfo(`Batch ${iteration}: ${batch.length} tasks in parallel`);
		updateSummary({ inProgress: batch.length }, workDir);

		if (dryRun) {
			logInfo("(dry run) Skipping batch");
			continue;
		}

		// Run agents in parallel
		const promises = batch.map((task) => {
			globalAgentNum++;
			return runAgentInWorktree(
				engine,
				task,
				globalAgentNum,
				baseBranch,
				worktreeBase,
				workDir,
				prdSource,
				prdFile,
				prdIsFolder,
				maxRetries,
				retryDelay,
				skipTests,
				skipLint,
				browserEnabled,
				modelOverride,
				tmux,
			);
		});

		const results = await Promise.all(promises);

		// Process results
		for (const agentResult of results) {
			const { task, worktreeDir, branchName, result: aiResult, error } = agentResult;

			if (error) {
				logError(`Task "${task.title}" failed: ${error}`);
				logTaskProgress(task.title, "failed", workDir);
				result.tasksFailed++;
				failedTaskIds.add(task.id);
				updateSummary({ failed: result.tasksFailed }, workDir);
				notifyTaskFailed(task.title, error);
			} else if (aiResult?.success) {
				logSuccess(`Task "${task.title}" completed`);
				result.totalInputTokens += aiResult.inputTokens;
				result.totalOutputTokens += aiResult.outputTokens;

				await taskSource.markComplete(task.id);
				logTaskProgress(task.title, "completed", workDir);
				result.tasksCompleted++;
				updateSummary({ completed: result.tasksCompleted }, workDir);
				notifyTaskComplete(task.title);

				// Track successful branch for merge phase
				if (branchName) {
					completedBranches.push(branchName);
				}
			} else {
				const errMsg = aiResult?.error || "Unknown error";
				logError(`Task "${task.title}" failed: ${errMsg}`);
				logTaskProgress(task.title, "failed", workDir);
				result.tasksFailed++;
				failedTaskIds.add(task.id);
				updateSummary({ failed: result.tasksFailed }, workDir);
				notifyTaskFailed(task.title, errMsg);
			}

			// Cleanup worktree
			if (worktreeDir) {
				// Don't cleanup if failed and using tmux, so user can debug
				if (tmux && (error || !aiResult?.success)) {
					logInfo(`Task failed. Worktree and tmux session preserved for debugging.`);
					logInfo(`Worktree: ${worktreeDir}`);
					continue;
				}

				const cleanup = await cleanupAgentWorktree(worktreeDir, branchName, workDir);
				if (cleanup.leftInPlace) {
					logInfo(`Worktree left in place (uncommitted changes): ${worktreeDir}`);
				}
			}
		}
	}

	// Merge phase: merge completed branches back to base branch
	if (!skipMerge && !dryRun && completedBranches.length > 0) {
		await mergeCompletedBranches(
			completedBranches,
			originalBaseBranch,
			engine,
			workDir,
			modelOverride,
		);

		// Restore starting branch if we're not already on it
		const currentBranch = await getCurrentBranch(workDir);
		if (currentBranch !== startingBranch) {
			logDebug(`Restoring starting branch: ${startingBranch}`);
			await returnToBaseBranch(startingBranch, workDir);
		}
	}

	return result;
}

/**
 * Merge completed branches back to the base branch
 */
async function mergeCompletedBranches(
	branches: string[],
	targetBranch: string,
	engine: AIEngine,
	workDir: string,
	modelOverride?: string,
): Promise<void> {
	if (branches.length === 0) {
		return;
	}

	logInfo(`\nMerge phase: merging ${branches.length} branch(es) into ${targetBranch}`);

	const merged: string[] = [];
	const failed: string[] = [];

	for (const branch of branches) {
		logInfo(`Merging ${branch}...`);

		const mergeResult = await mergeAgentBranch(branch, targetBranch, workDir);

		if (mergeResult.success) {
			logSuccess(`Merged ${branch}`);
			merged.push(branch);
		} else if (mergeResult.hasConflicts && mergeResult.conflictedFiles) {
			// Try AI-assisted conflict resolution
			logWarn(`Merge conflict in ${branch}, attempting AI resolution...`);

			const resolved = await resolveConflictsWithAI(
				engine,
				mergeResult.conflictedFiles,
				branch,
				workDir,
				modelOverride,
			);

			if (resolved) {
				logSuccess(`Resolved conflicts and merged ${branch}`);
				merged.push(branch);
			} else {
				logError(`Failed to resolve conflicts for ${branch}`);
				await abortMerge(workDir);
				failed.push(branch);
			}
		} else {
			logError(`Failed to merge ${branch}: ${mergeResult.error || "Unknown error"}`);
			failed.push(branch);
		}
	}

	// Delete successfully merged branches
	for (const branch of merged) {
		const deleted = await deleteLocalBranch(branch, workDir, true);
		if (deleted) {
			logDebug(`Deleted merged branch: ${branch}`);
		}
	}

	// Summary
	if (merged.length > 0) {
		logSuccess(`Successfully merged ${merged.length} branch(es)`);
	}
	if (failed.length > 0) {
		logWarn(`Failed to merge ${failed.length} branch(es): ${failed.join(", ")}`);
		logInfo("These branches have been preserved for manual review.");
	}
}
