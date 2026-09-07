export const LIVE2D_PREP_MODEL = 'doubao-seedream-4-5-251128';
// Seedream 4.5 requires a generated image of at least 3,686,400 pixels.
export const LIVE2D_PREP_SIZE = '1536x2400';

/**
 * A deliberately small, repeatable character lock for one source image.
 * It prepares an input for PSD decomposition; it does not claim to rig it.
 */
export function live2dPrepPrompt() {
  return `以输入图为唯一角色设定，生成一张用于 Live2D PSD 拆分的生产级角色参考图。严格保留角色身份、五官、发型、身体拓扑、比例、服装结构、配饰、配色、材质与原画风格，不得重新设计角色。

只输出一个完整角色：中立、直立、正面站姿；完整展示头部、头发、躯干、左右手臂、双手、臀胯、双腿、双脚及所有标志性配饰。左右肢体从连接处到末端必须解剖连续、清楚分离、完全置于画幅内；双臂自然下垂或轻微外展，手肘、手腕与躯干和裙摆之间留出清晰可见的空隙，双手不贴身体、不被衣物遮住。手放松且无透视夸张。角色居中置于 2:3 竖幅，头、手、脚周围留有充足留白。

以输入图的原画风格为准，不强制转换成赛璐璐、清晰线稿或其他新画风。仅在不改变原画语言的前提下，适度压低过强的三维渲染感、摄影感、油亮材质、景深、体积光和镜头光晕；保留输入图本身已有的笔触、线条、色阶、材质表现与角色辨识度。若输入是现实人物照片、强写实绘画或近似 3D 的人物图，严格保留可识别的脸部特征、发型、服装和配饰，但转换为偏平面、二维动画感的二次元角色插画：减少真实皮肤毛孔、镜头光影和立体渲染，不做真人照片效果或 3D 建模效果。

优先输出带真实 Alpha 通道的透明 PNG 背景，角色外轮廓完整干净；绝不能用透明棋盘格假装透明。若本次输出能力无法生成 Alpha，则改用无地面阴影、无场景的均匀极浅灰纯背景，便于后续抠图。不要场景、文字、水印、边框、拼贴、重复角色或额外道具。避免身份漂移、服装改变、配饰缺失、肢体裁切、断肢、额外或缺失的手指/肢体、肢体粘连、重叠错误、强透视、戏剧性姿势、动态模糊和风格替换。这是中立拆分源图，不是已经绑定的 Live2D 模型。`;
}

export function isPng(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer.slice(0, 8));
  return (
    bytes.length === 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  );
}

export function isJpeg(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer.slice(0, 3));
  return bytes.length === 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}
