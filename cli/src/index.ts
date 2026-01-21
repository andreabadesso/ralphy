#!/usr/bin/env bun
import "./polyfill.ts";
import { parseArgs } from "./cli/args.ts";
import { logError } from "./ui/logger.ts";

async function main(): Promise<void> {
	// Register signal handlers for cleanup
	const cleanup = async () => {
		try {
			const { cleanupTmuxSessions } = await import("./execution/state.ts");
			cleanupTmuxSessions();
		} catch {
			// Ignore
		}
		process.exit(0);
	};

	process.on("SIGINT", cleanup);
	process.on("SIGTERM", cleanup);

	try {
		const {
			options,
			task,
			initMode,
			showConfig: showConfigMode,
			addRule: rule,
		} = parseArgs(process.argv);

		// Handle --init
		if (initMode) {
			const { runInit } = await import("./cli/commands/init.ts");
			await runInit();
			return;
		}

		// Handle --config
		if (showConfigMode) {
			const { showConfig } = await import("./cli/commands/config.ts");
			await showConfig();
			return;
		}

		// Handle --add-rule
		if (rule) {
			const { addRule } = await import("./cli/commands/config.ts");
			await addRule(rule);
			return;
		}

		// Single task mode (brownfield)
		if (task) {
			const { runTask } = await import("./cli/commands/task.ts");
			await runTask(task, options);
			return;
		}

		// PRD loop mode
		const { runLoop } = await import("./cli/commands/run.ts");
		await runLoop(options);
	} catch (error) {
		logError(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}

main();

