export const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==', 'base64');
export function installScreenStandIn(app) {
  const bounds = { x: -900, y: 0, w: 900, h: 600 };
  const target = { kind: 'window', handle: '12', processId: 7, bounds };
  const windows = [{ handle: '12', processId: 7, title: 'Fixture editor', program: 'notepad', className: 'Notepad',
    x: -900, y: 0, width: 900, height: 600, minimised: false }];
  const seen = { enumerated: 0, opened: 0, closed: 0, captured: 0, effects: [], held: false, stopped: null };
  app.desktop.captureTargets = async (_owner, guard, signal) => {
    guard(); signal.throwIfAborted(); seen.enumerated++;
    return { windows, monitors: [{ kind: 'monitor', deviceName: 'monitor2', bounds }], excludedProcessId: 99 };
  };
  app.desktop.chatScreen = async (_owner, options) => {
    options.guard(); options.signal.throwIfAborted(); seen.opened++; seen.stopped = options.stopped;
    let closed = false;
    return { visible: () => !closed, takeOver: () => { options.guard(); seen.held = true; },
      handBack: () => { seen.held = false; }, pointer: () => null,
      frames: { next: async (_width, signal) => {
        options.guard(); signal.throwIfAborted(); seen.captured++;
        return { bytes: JPEG, type: 'image/jpeg', width: 900, height: 600, target, method: 'window', screen: bounds, windows, after: windows };
      }, close() {} },
      act: async (action, signal) => { options.guard(); signal.throwIfAborted(); seen.effects.push(action); },
      close: async () => { if (!closed) { closed = true; seen.closed++; seen.held = false; } },
    };
  };
  return seen;
}