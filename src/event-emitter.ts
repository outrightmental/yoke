export type DashboardEventType =
  | "cycle-start"
  | "phase-update"
  | "action-start"
  | "action-complete"
  | "action-error"
  | "workflow-approval"
  | "snapshot-update"
  | "plan-update"
  | "iteration-start"
  | "iteration-complete"
  | "broadcast-github-activity"
  | "broadcast-commit"
  | "broadcast-pr-update"
  | "broadcast-ci-status"
  | "broadcast-review-comment"
  | "broadcast-issue-update"
  | "lifecycle-update"
  | "log-message"
  | "engine-idle"
  | "github-rate-limit"
  | "github-rate-limit-cleared"
  // A hold parking the whole pool (Claude usage limit, GitHub rate limit) and
  // its lifting. Emitted once per hold, not once per engine.
  | "work-hold"
  | "work-hold-cleared"
  | "shutdown-requested"
  | "engine-shutdown"
  | "app-shutdown"
  | "cylinder-cancel"
  | "css-reload";

export interface DashboardEvent {
  type: DashboardEventType;
  timestamp: string;
  data: Record<string, unknown>;
}

export class EventEmitter {
  private listeners: Set<(event: DashboardEvent) => void> = new Set();

  subscribe(listener: (event: DashboardEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(type: DashboardEventType, data: Record<string, unknown>): void {
    const event: DashboardEvent = {
      type,
      timestamp: new Date().toISOString(),
      data,
    };
    // Listeners are called synchronously, so a throw from one used to propagate
    // straight back into whatever emitted the event — a dashboard WebSocket
    // send failing could therefore unwind an engine loop. A subscriber's
    // problem is never the publisher's problem.
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        process.stderr.write(
          `[yoke] event listener for "${type}" threw: ${
            error instanceof Error ? (error.stack ?? error.message) : String(error)
          }\n`,
        );
      }
    }
  }

  getListenerCount(): number {
    return this.listeners.size;
  }
}

export const globalEventEmitter = new EventEmitter();
