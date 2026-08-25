export const DEFAULT_ACTIVITY_CAPACITY = 200;

/**
 * @typedef {object} ActivityDelivery
 * @property {number} id
 * @property {string} ts
 * @property {"mcp" | "stream"} channel
 * @property {string} client
 * @property {string} tool
 * @property {Record<string, unknown>} args
 * @property {string} text
 * @property {boolean} error
 */

/** @typedef {"stream" | "wait" | "viewer"} ActivityConnectionKind */
/** @typedef {(event: "presence" | "delivery" | "clear", payload: any) => void} ActivitySubscriber */
/** @typedef {ReturnType<typeof createActivity>} Activity */

/**
 * Tracks active observers and a bounded, in-memory transcript of what log
 * payloads were delivered to agents. This is deliberately separate from the
 * log store: clearing application logs does not rewrite the observation trail.
 */
export function createActivity({ capacity = DEFAULT_ACTIVITY_CAPACITY } = {}) {
  /** @type {ActivityDelivery[]} */
  let deliveries = [];
  let deliveryId = 0;
  let clientId = 0;
  const counts = { stream: 0, wait: 0, viewer: 0 };
  /** @type {Set<ActivitySubscriber>} */
  const subscribers = new Set();

  const snapshot = () => ({
    monitors: counts.stream + counts.wait,
    streams: counts.stream,
    waits: counts.wait,
    viewers: counts.viewer,
  });

  /** @param {"presence" | "delivery" | "clear"} event @param {unknown} payload */
  const publish = (event, payload) => {
    for (const notify of subscribers) notify(event, payload);
  };

  /** @param {ActivityConnectionKind} kind */
  function open(kind) {
    const id = `${kind}-${++clientId}`;
    let closed = false;
    counts[kind]++;
    publish("presence", snapshot());
    return {
      id,
      close() {
        if (closed) return;
        closed = true;
        counts[kind]--;
        publish("presence", snapshot());
      },
    };
  }

  /** @param {Omit<ActivityDelivery, "id" | "ts">} input */
  function deliver(input) {
    const delivery = {
      id: ++deliveryId,
      ts: new Date().toISOString(),
      ...input,
    };
    deliveries.push(delivery);
    if (deliveries.length > capacity) deliveries.splice(0, deliveries.length - capacity);
    publish("delivery", delivery);
    return delivery;
  }

  function clear() {
    const cleared = deliveries.length;
    deliveries = [];
    publish("clear", { cleared });
    return { cleared };
  }

  /** @param {ActivitySubscriber} notify */
  function subscribe(notify) {
    subscribers.add(notify);
    return () => subscribers.delete(notify);
  }

  return {
    open,
    deliver,
    clear,
    subscribe,
    snapshot,
    recent: () => deliveries.slice(),
  };
}
