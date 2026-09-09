import { createBackendProject, uploadBackendArtifact } from './morphBackend';

export type ProductionTask = {
  id: string;
  name: string;
  inputFile?: string;
  inputKind?: string;
  mode?: 'standard' | 'pro';
  createdAt: string;
};

export async function createProjectFromLocalTask(task: ProductionTask, source: Blob | null) {
  const inputMode = task.mode === 'pro' ? 'pro' : task.inputKind === 'psd' || task.inputKind === 'stretch' ? task.inputKind : 'image';
  const created = await createBackendProject({
    title: task.name,
    inputMode,
    metadata: { local_task_id: task.id, created_in_browser_at: task.createdAt },
  });
  if (!source || !task.inputFile) return { projectId: created.project.id };
  await uploadBackendArtifact({
    projectId: created.project.id, kind: 'source', filename: task.inputFile, blob: source, retentionClass: 'permanent',
  });
  return { projectId: created.project.id };
}

export async function uploadProjectArtifact(input: {
  projectId: string;
  kind: 'prepared_image' | 'psd' | 'cmo3' | 'moc3_bundle' | 'stretch' | 'report' | 'preview';
  filename: string;
  blob: Blob;
}) {
  return uploadBackendArtifact({
    projectId: input.projectId,
    kind: input.kind,
    filename: input.filename,
    blob: input.blob,
    retentionClass: input.kind === 'preview' || input.kind === 'report' ? 'diagnostic' : 'permanent',
  });
}
