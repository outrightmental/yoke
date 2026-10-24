import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket as WsWebSocket, WebSocketServer } from "ws";
import { WsClient } from "../src/dashboard/store/ws-client.js";

// Node.js < 22 does not expose WebSocket as a global; polyfill it from the
// 'ws' package so ws-client.ts (browser code) works in the test environment.
if (typeof globalThis.WebSocket === "undefined") {
  (globalThis as unknown as { WebSocket: typeof WsWebSocket }).WebSocket = WsWebSocket;
}

const BASE_PORT = 19_700;

function waitMs(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

test("WsClient: onConnectionChange(true) is called when WebSocket opens", async (t) => {
  const port = BASE_PORT;
  const wss = new WebSocketServer({ host: "127.0.0.1", port });
  const client = new WsClient(
    `ws://127.0.0.1:${port}`,
    () => {},
    undefined,
    (connected) => { connectionChange = connected; }
  );
  t.after(() => { client.close(); wss.close(); });

  let connectionChange: boolean | null = null;
  client.connect();

  await waitMs(150);

  assert.equal(connectionChange, true, "onConnectionChange should be called with true when WebSocket opens");
});

test("WsClient: onConnectionChange(false) is called when WebSocket closes", async (t) => {
  const port = BASE_PORT + 1;
  const wss = new WebSocketServer({ host: "127.0.0.1", port });
  const client = new WsClient(
    `ws://127.0.0.1:${port}`,
    () => {},
    undefined,
    (connected) => { states.push(connected); }
  );
  t.after(() => { client.close(); wss.close(); });

  const states: boolean[] = [];
  client.connect();

  await waitMs(150);
  assert.equal(states[0], true, "first change should be true (connected)");

  // Close server to trigger disconnect
  wss.clients.forEach(ws => ws.close());
  await waitMs(150);

  assert.equal(states.at(-1), false, "last change should be false (disconnected)");
});

test("WsClient: onConnectionChange(false) is called when connection is refused", async (t) => {
  const port = BASE_PORT + 2;

  let connectionChange: boolean | null = null;
  const client = new WsClient(
    `ws://127.0.0.1:${port}`,
    () => {},
    undefined,
    (connected) => { connectionChange = connected; }
  );
  t.after(() => client.close());
  client.connect();

  await waitMs(500);

  assert.equal(connectionChange, false, "onConnectionChange should be called with false when connection is refused");
});

test("DashboardStore: connection becomes 'connected' after connectLive WebSocket opens", async (t) => {
  const port = BASE_PORT + 3;
  const { DashboardServer } = await import("../src/dashboard-server.js");

  const server = new DashboardServer({
    port,
    host: "127.0.0.1",
    owner: "test",
    repo: "repo",
  });
  await server.initialize();
  await server.start();

  // Polyfill fetch to hit the test server instead of location.host
  const origFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === "string" ? input : input.toString();
    return origFetch(`http://127.0.0.1:${port}${path}`, init);
  }) as typeof fetch;

  const { DashboardStore } = await import("../src/dashboard/store/dashboard-store.js");
  const store = new DashboardStore();
  t.after(() => { store.disconnect(); server.close(); globalThis.fetch = origFetch; });

  await store.bootstrap();

  const wsUrl = `ws://127.0.0.1:${port}/api/ws`;
  store.connectLive(wsUrl);

  await waitMs(300);

  assert.equal(store.getState().connection, "connected", "store connection should be 'connected' after WebSocket opens");
});

test("DashboardStore: connection becomes 'disconnected' when WebSocket server closes", async (t) => {
  const port = BASE_PORT + 4;
  const { DashboardServer } = await import("../src/dashboard-server.js");

  const server = new DashboardServer({
    port,
    host: "127.0.0.1",
    owner: "test",
    repo: "repo",
  });
  await server.initialize();
  await server.start();

  const origFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === "string" ? input : input.toString();
    return origFetch(`http://127.0.0.1:${port}${path}`, init);
  }) as typeof fetch;

  const { DashboardStore } = await import("../src/dashboard/store/dashboard-store.js");
  const store = new DashboardStore();
  t.after(() => { store.disconnect(); globalThis.fetch = origFetch; });

  await store.bootstrap();

  const wsUrl = `ws://127.0.0.1:${port}/api/ws`;
  store.connectLive(wsUrl);

  await waitMs(300);
  assert.equal(store.getState().connection, "connected");

  // Now close the server and verify disconnection is detected
  server.close();
  await waitMs(500);

  assert.equal(store.getState().connection, "disconnected", "store connection should be 'disconnected' after server closes");
});

test("WsClient.send: delivers a message as JSON once open, and sends nothing before", async (t) => {
  const port = BASE_PORT + 5;
  const wss = new WebSocketServer({ host: "127.0.0.1", port });
  const received: unknown[] = [];
  wss.on("connection", (ws) => ws.on("message", (data: Buffer) => received.push(JSON.parse(data.toString()))));
  const client = new WsClient(`ws://127.0.0.1:${port}`, () => {});
  t.after(() => { client.close(); wss.close(); });

  assert.equal(client.send({ type: "early" }), false, "no socket yet");
  client.connect();
  assert.equal(client.send({ type: "early" }), false, "still connecting: not queued for later");
  await waitMs(150);

  assert.equal(client.send({ type: "pull-request-approve-request", repo: "o/a", pullRequestNumber: 10 }), true);
  await waitMs(100);
  assert.deepEqual(received, [{ type: "pull-request-approve-request", repo: "o/a", pullRequestNumber: 10 }]);
});

test("DashboardStore.approvePullRequest: an Approve click reaches the engine pool (#274)", async (t) => {
  const port = BASE_PORT + 6;
  const { DashboardServer } = await import("../src/dashboard-server.js");
  const { EventEmitter } = await import("../src/event-emitter.js");
  const emitter = new EventEmitter();
  const heard: unknown[] = [];
  emitter.subscribe((event) => {
    if (event.type === "pull-request-approve") heard.push(event.data);
  });
  const server = new DashboardServer({
    port,
    host: "127.0.0.1",
    owner: "",
    repo: "",
    multiProject: true,
    projects: ["o/a", "o/b"],
    eventEmitter: emitter,
  });
  await server.initialize();
  await server.start();

  const { DashboardStore } = await import("../src/dashboard/store/dashboard-store.js");
  const store = new DashboardStore();
  t.after(() => { store.disconnect(); server.close(); });

  assert.equal(store.approvePullRequest({ repo: "o/b", pullRequestNumber: 10 }), false, "not connected yet");
  store.connectLive(`ws://127.0.0.1:${port}/api/ws`);
  await waitMs(300);

  assert.equal(store.approvePullRequest({ repo: "o/b", pullRequestNumber: 10 }), true);
  await waitMs(100);
  assert.deepEqual(heard, [{ repo: "o/b", pullRequestNumber: 10 }]);
});
