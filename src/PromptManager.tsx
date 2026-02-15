import {
  addOpenPromptChangeListener,
  readOpenPrompts,
  removeOpenPromptChangeListener,
  updateOpenPrompts
} from './storage';
import { OpenPromptItem } from './types';

const managerFunctions = {
  add: async (item: OpenPromptItem) => {
    const openPrompts = (await readOpenPrompts()) ?? [];
    openPrompts.push(item);
    return await updateOpenPrompts(openPrompts);
  },
  get: async () => {
    return await readOpenPrompts();
  },
  remove: async (id: string) => {
    const openPrompts = (await readOpenPrompts()) ?? [];
    return await updateOpenPrompts(openPrompts.filter(item => item.id !== id));
  },
  clear: async () => {
    return await updateOpenPrompts([]);
  },
  addChangeListener: (callback: (newOpenPrompts: OpenPromptItem[]) => void) => {
    return addOpenPromptChangeListener(callback);
  },
  removeChangeListener: (listener: (newOpenPrompts: OpenPromptItem[]) => void) => {
    return removeOpenPromptChangeListener(listener);
  }
};

/**
 * Subscribe to open prompts changes. Returns an unsubscribe function.
 * Used by Inferno class components instead of the old React hook.
 */
export function subscribeOpenPrompts(
  callback: (prompts: OpenPromptItem[]) => void
): () => void {
  // Initialize with existing prompts
  managerFunctions.get().then((existing: OpenPromptItem[]) => {
    callback(existing);
  });

  // Listen for changes
  const listener = (newOpenPrompts: OpenPromptItem[]) => {
    callback(newOpenPrompts);
  };
  managerFunctions.addChangeListener(listener);

  return () => {
    managerFunctions.removeChangeListener(listener);
  };
}

export default managerFunctions;
