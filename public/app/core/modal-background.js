/* A modal's background is excluded from pointer, keyboard and accessibility navigation.
   Keep each sibling's previous inert value, including while an account dialog sits over setup. */
const kept = new Map();
let watched = null;

export function syncModalBackground() {
  const root = document.getElementById("app");
  if (!root) return;
  if (watched !== root) {
    watched = root;
    new MutationObserver(syncModalBackground).observe(root, { childList: true });
  }
  const children = [...root.children];
  const modal = children.filter((node) => node.matches(".scrim, .ob9, .first, .qawrap17c")).at(-1);
  for (const [node, original] of kept) {
    if (!modal || node === modal || node.matches(".pop") || !node.isConnected) {
      node.inert = original;
      kept.delete(node);
    }
  }
  if (!modal) return;
  for (const node of children) {
    if (node === modal || node.matches(".pop")) continue;
    if (!kept.has(node)) kept.set(node, node.inert);
    node.inert = true;
  }
}
