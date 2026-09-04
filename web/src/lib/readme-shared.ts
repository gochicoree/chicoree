// Repository README: limits shared by the editor (client) and the action.

export const README_MAX_BYTES = 64 * 1024;

export function readmeBytes(markdown: string): number {
  return new TextEncoder().encode(markdown).length;
}
