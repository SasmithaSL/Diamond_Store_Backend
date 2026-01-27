const subscribers = new Map();

function addSubscriber(idNumber, res) {
  const key = idNumber.toString();
  const set = subscribers.get(key) || new Set();
  set.add(res);
  subscribers.set(key, set);
}

function removeSubscriber(idNumber, res) {
  const key = idNumber.toString();
  const set = subscribers.get(key);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) {
    subscribers.delete(key);
  }
}

function notifyStatus(idNumber, status) {
  const key = idNumber.toString();
  const set = subscribers.get(key);
  if (!set || set.size === 0) return;

  const payload = JSON.stringify({ status });
  for (const res of Array.from(set)) {
    try {
      res.write(`event: status\ndata: ${payload}\n\n`);
      if (status !== "PENDING") {
        res.end();
        set.delete(res);
      }
    } catch (err) {
      set.delete(res);
    }
  }

  if (set.size === 0) {
    subscribers.delete(key);
  }
}

module.exports = {
  addSubscriber,
  removeSubscriber,
  notifyStatus,
};
