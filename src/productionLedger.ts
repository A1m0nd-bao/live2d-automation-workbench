import { productionClient } from './supabaseProduction';

export type ProductionTask = {
  id: string;
  name: string;
  inputFile?: string;
  inputKind?: string;
  mode?: 'standard' | 'pro';
  createdAt: string;
};

export type WorkspaceMembership = {
  workspaceId: string;
  role: 'admin' | 'creator';
};

function clientOrThrow() {
  const client = productionClient();
  if (!client) throw new Error('生产账户服务尚未配置。');
  return client;
}

/** The first active membership is the creator's default studio workspace. */
export async function currentWorkspace(): Promise<WorkspaceMembership | null> {
  const client = clientOrThrow();
  const { data, error } = await client
    .from('workspace_members')
    .select('workspace_id, role')
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return { workspaceId: data.workspace_id, role: data.role as WorkspaceMembership['role'] };
}

/**
 * Creates the durable project record before copying its input to the private
 * bucket.  Outputs are deliberately left to the worker's service-role path.
 */
export async function createProjectFromLocalTask(task: ProductionTask, source: Blob | null) {
  const client = clientOrThrow();
  const workspace = await currentWorkspace();
  if (!workspace) throw new Error('该邮箱尚未加入工作区，请让管理员发送邀请。');
  const { data: auth, error: authError } = await client.auth.getUser();
  if (authError) throw authError;
  if (!auth.user) throw new Error('登录已过期，请重新登录。');

  const inputMode = task.mode === 'pro' ? 'pro' : task.inputKind === 'psd' || task.inputKind === 'stretch' ? task.inputKind : 'image';
  const { data: project, error: projectError } = await client
    .from('projects')
    .insert({
      workspace_id: workspace.workspaceId,
      created_by: auth.user.id,
      title: task.name,
      input_mode: inputMode,
      metadata: { local_task_id: task.id, created_in_browser_at: task.createdAt },
    })
    .select('id')
    .single();
  if (projectError) throw projectError;

  if (!source || !task.inputFile) return { projectId: project.id, workspace };
  const safeName = task.inputFile.replace(/[^a-zA-Z0-9._-]/g, '_');
  const storagePath = `${workspace.workspaceId}/${project.id}/source/${safeName}`;
  const { error: uploadError } = await client.storage
    .from('live2d-assets')
    .upload(storagePath, source, { upsert: false, contentType: source.type || 'application/octet-stream' });
  if (uploadError) throw uploadError;
  const { error: artifactError } = await client.from('artifacts').insert({
    workspace_id: workspace.workspaceId,
    project_id: project.id,
    kind: 'source',
    storage_path: storagePath,
    filename: task.inputFile,
    mime_type: source.type || null,
    byte_size: source.size,
    retention_class: 'permanent',
  });
  if (artifactError) throw artifactError;
  return { projectId: project.id, workspace };
}

export async function uploadProjectArtifact(input: {
  projectId: string;
  kind: 'prepared_image' | 'psd' | 'cmo3' | 'moc3_bundle' | 'stretch' | 'report' | 'preview';
  filename: string;
  blob: Blob;
}) {
  const client = clientOrThrow();
  const workspace = await currentWorkspace();
  if (!workspace) throw new Error('该邮箱尚未加入工作区，请让管理员发送邀请。');
  const safeName = input.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const storagePath = `${workspace.workspaceId}/${input.projectId}/artifacts/${input.kind}/${safeName}`;
  const { error: uploadError } = await client.storage
    .from('live2d-assets')
    .upload(storagePath, input.blob, { upsert: false, contentType: input.blob.type || 'application/octet-stream' });
  if (uploadError) throw uploadError;
  const { error: artifactError } = await client.from('artifacts').insert({
    workspace_id: workspace.workspaceId,
    project_id: input.projectId,
    kind: input.kind,
    storage_path: storagePath,
    filename: input.filename,
    mime_type: input.blob.type || null,
    byte_size: input.blob.size,
    retention_class: input.kind === 'preview' || input.kind === 'report' ? 'diagnostic' : 'permanent',
    delete_after: input.kind === 'preview' || input.kind === 'report'
      ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
      : null,
  });
  if (artifactError) throw artifactError;
  return storagePath;
}
