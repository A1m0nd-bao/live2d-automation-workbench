export type PrepMode = 'generate' | 'confirmed-source';

// Transport configuration must never decide whether image generation runs.
export async function selectPreparation<T>(mode: PrepMode | undefined, actions: {
  generate: () => Promise<T>;
  confirmedSource: () => Promise<T>;
}): Promise<T> {
  return mode === 'confirmed-source' ? actions.confirmedSource() : actions.generate();
}

export function isPrepCommand(command: string) {
  return command === 'prepare' || command === 'prepHealth';
}
