// Board news waiting for a session (an item it holds was unblocked, finished elsewhere, or its claim was taken over),
// worded for the user. It clears once the session has heard: on its next prompt, or from its `office-todo wait` watcher.
const TEXT = {
  unblocked: (n) => `🔓 Unblocked: ${n.title} — ready when you are`,
  done: (n) => `✅ Finished by ${n.who || 'someone else'}: ${n.title}`,
  takeover: (n) => `↪ ${n.who || 'Someone'} took over: ${n.title}`,
};

export const newsText = (n) => (TEXT[n.kind] || ((x) => x.title || ''))(n);
