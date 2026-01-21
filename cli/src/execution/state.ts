import { writeFileSync } from "node:fs";
import { getStatePath } from "../config/loader.ts";

export interface AgentState {
	id: string;
	task: string;
	status: "pending" | "running" | "completed" | "failed";
	step: string;
	tmuxSession?: string;
	worktreeDir?: string;
	error?: string;
	lastUpdate: string;
}

export interface RalphyState {
	agents: Record<string, AgentState>;
	summary: {
		total: number;
		completed: number;
		failed: number;
		inProgress: number;
	};
	lastUpdate: string;
}

let currentState: RalphyState = {
	agents: {},
	summary: {
		total: 0,
		completed: 0,
		failed: 0,
		inProgress: 0,
	},
	lastUpdate: new Date().toISOString(),
};

/**
 * Update global summary
 */
export function updateSummary(
	updates: Partial<RalphyState["summary"]>,
	workDir: string,
): void {
	currentState.summary = {
		...currentState.summary,
		...updates,
	};
	currentState.lastUpdate = new Date().toISOString();
	saveState(workDir);
}

/**
 * Update the state and save to disk
 */
export function updateState(
	agentId: string,
	updates: Partial<AgentState>,
	workDir: string,
): void {
	const now = new Date().toISOString();
	
	if (!currentState.agents[agentId]) {
		currentState.agents[agentId] = {
			id: agentId,
			task: "",
			status: "pending",
			step: "Initializing",
			lastUpdate: now,
		};
	}

	currentState.agents[agentId] = {
		...currentState.agents[agentId],
		...updates,
		lastUpdate: now,
	};
	
	currentState.lastUpdate = now;
	saveState(workDir);
}

/**
 * Cleanup: Kill all active tmux sessions
 */
export function cleanupTmuxSessions(): void {
	for (const agent of Object.values(currentState.agents)) {
		if (agent.tmuxSession && (agent.status === "running" || agent.status === "pending")) {
			try {
				Bun.spawnSync(["tmux", "kill-session", "-t", agent.tmuxSession]);
			} catch {
				// Ignore
			}
		}
	}
}

/**
 * Save state to disk
 */
function saveState(workDir: string): void {
	try {
		const statePath = getStatePath(workDir);
		writeFileSync(statePath, JSON.stringify(currentState, null, 2));
	} catch (error) {
		// Ignore errors writing state
	}
}

/**
 * Remove an agent from state
 */
export function removeAgentFromState(agentId: string, workDir: string): void {
	delete currentState.agents[agentId];
	currentState.lastUpdate = new Date().toISOString();
	saveState(workDir);
}
