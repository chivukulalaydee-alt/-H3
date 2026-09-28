const $ = (selector) => document.querySelector(selector);

const elements = {
  form: $('#generation-form'),
  apiKey: $('#api-key'),
  toggleKey: $('#toggle-key'),
  testKey: $('#test-key'),
  prompt: $('#prompt'),
  promptCount: $('#prompt-count'),
  duration: $('#duration'),
  resolution: $('#resolution'),
  ratio: $('#ratio'),
  seed: $('#seed'),
  referenceImage: $('#reference-image'),
  character1Image: $('#character-1-image'),
  character2Image: $('#character-2-image'),
  backgroundImage: $('#background-image'),
  audio1: $('#audio-1'),
  audio2: $('#audio-2'),
  audioTotal: $('#audio-total'),
  formMessage: $('#form-message'),
  submitButton: $('#submit-button'),
  resetButton: $('#reset-button'),
  stageTrack: $('#stage-track'),
  stateBadge: $('#state-badge'),
  stateTitle: $('#state-title'),
  stateDescription: $('#state-description'),
  progressValue: $('#progress-value'),
  progressFill: $('#progress-fill'),
  taskId: $('#task-id'),
  elapsedTime: $('#elapsed-time'),
  copyTaskId: $('#copy-task-id'),
  refreshTask: $('#refresh-task'),
  stopPolling: $('#stop-polling'),
  video: $('#result-video'),
  videoEmpty: $('#video-empty'),
  loadVideo: $('#load-video'),
  openVideo: $('#open-video'),
  downloadVideo: $('#download-video'),
  rawResponse: $('#raw-response'),
  historyList: $('#history-list'),
  clearHistory: $('#clear-history'),
  localStatus: $('#local-status'),
  gatewayLabel: $('#gateway-label'),
};

const HISTORY_KEY = 'mojiang-h3-workbench-history-v1';
const TERMINAL_FAILURES = new Set(['failed', 'error', 'cancelled', 'canceled']);
const COMPLETED_STATES = new Set(['completed', 'succeeded', 'success', 'done']);
const fileFields = [
  ['reference_image', elements.referenceImage],
  ['character_1_image', elements.character1Image],
  ['character_2_image', elements.character2Image],
  ['background_image', elements.backgroundImage],
  ['audio_1', elements.audio1],
  ['audio_2', elements.audio2],
];

const state = {
  taskId: '',
  taskStatus: 'idle',
  startedAt: 0,
  pollTimer: null,
  elapsedTimer: null,
  videoUrl: '',
  finalizationAttempts: 0,
  isPolling: false,
};

class ApiError extends Error {
  constructor(message, status = 0, type = 'request_error') {
    super(message);
    this.status = status;
    this.type = type;
  }
}

function apiKey() {
  const key = elements.apiKey.value.trim();
  if (!key) throw new ApiError('请先填写 API 密钥。', 401, 'missing_api_key');
  return key;
}

async function apiRequest(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('X-Workbench-Api-Key', apiKey());
  const response = await fetch(path, { ...options, headers });
  if (!response.ok) {
    let message = `请求失败（HTTP ${response.status}）`;
    let type = 'request_error';
    try {
      const payload = await response.json();
      message = payload?.error?.message || payload?.message || message;
      type = payload?.error?.type || type;
    } catch {
      // Keep the bounded status message.
    }
    throw new ApiError(message, response.status, type);
  }
  return options.expectBlob ? response.blob() : response.json();
}

function setFormMessage(message = '', kind = 'error') {
  elements.formMessage.textContent = message;
  elements.formMessage.classList.toggle('success', kind === 'success');
}

function formatElapsed(ms) {
  if (!ms) return '—';
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes ? `${minutes}分 ${String(seconds).padStart(2, '0')}秒` : `${seconds}秒`;
}

function beginElapsedTimer() {
  clearInterval(state.elapsedTimer);
  const update = () => {
    elements.elapsedTime.textContent = formatElapsed(Date.now() - state.startedAt);
  };
  update();
  state.elapsedTimer = setInterval(update, 1000);
}

function stopElapsedTimer() {
  clearInterval(state.elapsedTimer);
  state.elapsedTimer = null;
}

function extractProgress(payload) {
  const candidates = [payload?.progress, payload?.data?.progress, payload?.percentage, payload?.data?.percentage];
  for (const value of candidates) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return Math.max(0, Math.min(100, numeric));
  }
  return 0;
}

function extractStatus(payload) {
  return String(payload?.status || payload?.data?.status || payload?.state || 'processing').toLowerCase();
}

function stageFor(status, progress) {
  if (COMPLETED_STATES.has(status)) return 'completed';
  if (TERMINAL_FAILURES.has(status)) return 'failed';
  if (['queued', 'pending', 'created', 'submitted'].includes(status)) return 'queued';
  if (['finalizing', 'quality_check', 'reviewing'].includes(status) || progress >= 85) return 'quality';
  return 'processing';
}

function setTrackStage(stage) {
  const order = ['queued', 'processing', 'quality', 'completed'];
  const activeIndex = order.indexOf(stage);
  elements.stageTrack.dataset.stage = stage;
  const stages = [...elements.stageTrack.querySelectorAll('.stage')];
  const lines = [...elements.stageTrack.querySelectorAll('.stage-line')];
  stages.forEach((element, index) => {
    element.classList.toggle('active', index === activeIndex && stage !== 'failed');
    element.classList.toggle('done', stage === 'completed' || (activeIndex > index && stage !== 'failed'));
  });
  lines.forEach((line, index) => line.classList.toggle('done', stage === 'completed' || activeIndex > index));
}

function updateTaskUi({ status = 'idle', progress = 0, title, description } = {}) {
  state.taskStatus = status;
  const stage = stageFor(status, progress);
  setTrackStage(stage);
  const labels = {
    idle: ['等待提交', '尚未创建任务', '填写左侧配置后开始生成，任务状态会在这里自动更新。'],
    queued: ['排队中', '任务已进入队列', 'H3 正在等待可用的生成设备。'],
    processing: ['生成中', '视频正在生成', '页面会自动查询状态，关闭页面后仍可用任务 ID 恢复。'],
    quality: ['结果处理中', '正在整理视频结果', '任务已接近完成，正在等待可播放的视频文件。'],
    completed: ['已完成', '视频生成完成', '视频已准备好，可以播放或下载。'],
    failed: ['失败', '视频生成失败', '请查看接口响应和错误提示，修正后重新提交。'],
    stopped: ['已暂停', '自动查询已停止', '云端任务不会被取消，可随时手动刷新状态。'],
  };
  const labelKey = status === 'stopped' ? 'stopped' : stage;
  const fallback = labels[labelKey] || labels.processing;
  elements.stateBadge.className = `state-badge ${labelKey}`;
  elements.stateBadge.textContent = fallback[0];
  elements.stateTitle.textContent = title || fallback[1];
  elements.stateDescription.textContent = description || fallback[2];
  const safeProgress = Math.round(Math.max(0, Math.min(100, Number(progress) || 0)));
  elements.progressValue.textContent = `${safeProgress}%`;
  elements.progressFill.style.width = `${safeProgress}%`;
}

function setRawResponse(payload) {
  elements.rawResponse.textContent = JSON.stringify(payload, null, 2);
}

function extractTaskId(payload) {
  return payload?.id || payload?.task_id || payload?.video_id || payload?.data?.id || payload?.data?.task_id || '';
}

function getHistory() {
  try {
    const value = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    return Array.isArray(value) ? value.slice(0, 10) : [];
  } catch {
    return [];
  }
}

function saveHistory(entry) {
  const existing = getHistory().filter((item) => item.id !== entry.id);
  localStorage.setItem(HISTORY_KEY, JSON.stringify([entry, ...existing].slice(0, 10)));
  renderHistory();
}

function updateHistoryStatus(taskId, status) {
  const history = getHistory();
  const item = history.find((entry) => entry.id === taskId);
  if (item) {
    item.status = status;
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    renderHistory();
  }
}

function renderHistory() {
  const history = getHistory();
  elements.historyList.replaceChildren();
  if (!history.length) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = '还没有本地任务记录。';
    elements.historyList.append(empty);
    return;
  }
  for (const item of history) {
    const row = document.createElement('div');
    row.className = 'history-item';
    const code = document.createElement('code');
    code.textContent = item.id;
    const prompt = document.createElement('span');
    prompt.className = 'history-prompt';
    prompt.textContent = item.prompt || '未记录提示词摘要';
    const status = document.createElement('span');
    status.className = 'history-status';
    status.textContent = item.status || 'unknown';
    const resume = document.createElement('button');
    resume.type = 'button';
    resume.textContent = '恢复查询';
    resume.addEventListener('click', () => resumeTask(item));
    row.append(code, prompt, status, resume);
    elements.historyList.append(row);
  }
}

function releaseVideoUrl() {
  if (state.videoUrl) URL.revokeObjectURL(state.videoUrl);
  state.videoUrl = '';
  elements.video.removeAttribute('src');
  elements.video.load();
  elements.video.hidden = true;
  elements.videoEmpty.hidden = false;
  elements.openVideo.disabled = true;
  elements.downloadVideo.disabled = true;
}

function setTaskId(taskId) {
  state.taskId = taskId;
  elements.taskId.textContent = taskId || '—';
  elements.copyTaskId.disabled = !taskId;
  elements.refreshTask.disabled = !taskId;
  elements.loadVideo.disabled = !taskId;
}

function stopPolling(showState = false) {
  clearTimeout(state.pollTimer);
  state.pollTimer = null;
  state.isPolling = false;
  elements.stopPolling.disabled = true;
  if (showState && state.taskId) updateTaskUi({ status: 'stopped', progress: Number(elements.progressValue.textContent.replace('%', '')) || 0 });
}

function schedulePoll(delay = 5000) {
  clearTimeout(state.pollTimer);
  state.isPolling = true;
  elements.stopPolling.disabled = false;
  state.pollTimer = setTimeout(() => pollTask(), delay);
}

function errorDescription(error) {
  if (error.status === 401 || error.status === 403) return 'API 密钥无效或没有权限，请检查后重试。';
  if (error.status === 429) return '当前额度不足或请求过于频繁，请检查账户额度。';
  if (error.status === 503 || error.status === 502) return 'H3 服务当前不可用，请检查仙宫云实例或稍后重试。';
  if (error.status === 504) return '查询超时，云端任务可能仍在继续，可稍后刷新。';
  return error.message;
}

async function pollTask({ manual = false } = {}) {
  if (!state.taskId) return;
  clearTimeout(state.pollTimer);
  state.isPolling = true;
  elements.stopPolling.disabled = false;
  elements.refreshTask.disabled = true;
  try {
    const payload = await apiRequest(`/api/videos/${encodeURIComponent(state.taskId)}`);
    setRawResponse(payload);
    const status = extractStatus(payload);
    const progress = extractProgress(payload);
    const stage = stageFor(status, progress);
    updateTaskUi({ status, progress });
    updateHistoryStatus(state.taskId, status);

    if (TERMINAL_FAILURES.has(status)) {
      stopPolling();
      stopElapsedTimer();
      const message = payload?.error?.message || payload?.message || '上游返回失败状态。';
      setFormMessage(message);
      return;
    }

    if (COMPLETED_STATES.has(status)) {
      try {
        await loadVideo({ silent: true });
        stopPolling();
        stopElapsedTimer();
        updateTaskUi({ status: 'completed', progress: 100 });
        updateHistoryStatus(state.taskId, 'completed');
        return;
      } catch (error) {
        state.finalizationAttempts += 1;
        if ([404, 409, 425].includes(error.status) && state.finalizationAttempts <= 10) {
          updateTaskUi({ status: 'quality_check', progress: Math.max(95, progress), description: `任务已完成，视频文件正在就绪（${state.finalizationAttempts}/10）。` });
          schedulePoll(8000);
          return;
        }
        stopPolling();
        stopElapsedTimer();
        updateTaskUi({ status: 'completed', progress: 100, description: '任务已完成，但视频暂时无法加载。请稍后点击“加载视频”。' });
        setFormMessage(errorDescription(error));
        return;
      }
    }
    schedulePoll(manual ? 3000 : 5000);
  } catch (error) {
    if (manual || [401, 403, 429].includes(error.status)) stopPolling();
    else schedulePoll(8000);
    setFormMessage(errorDescription(error));
  } finally {
    elements.refreshTask.disabled = !state.taskId;
  }
}

async function getMediaDuration(file) {
  if (!file) return 0;
  const url = URL.createObjectURL(file);
  try {
    const audio = document.createElement('audio');
    audio.preload = 'metadata';
    audio.src = url;
    return await new Promise((resolve, reject) => {
      audio.onloadedmetadata = () => resolve(Number.isFinite(audio.duration) ? audio.duration : 0);
      audio.onerror = () => reject(new Error(`无法读取音频时长：${file.name}`));
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function updateAudioTotal() {
  try {
    const durations = await Promise.all([
      getMediaDuration(elements.audio1.files[0]),
      getMediaDuration(elements.audio2.files[0]),
    ]);
    const total = durations.reduce((sum, value) => sum + value, 0);
    elements.audioTotal.dataset.duration = String(total);
    elements.audioTotal.textContent = `参考音频总时长：${total.toFixed(1)} 秒${total > 15 ? '（超过 15 秒）' : ''}`;
    elements.audioTotal.classList.toggle('invalid', total > 15);
    return total;
  } catch (error) {
    elements.audioTotal.dataset.duration = 'invalid';
    elements.audioTotal.textContent = error.message;
    elements.audioTotal.classList.add('invalid');
    return Number.NaN;
  }
}

function validateForm() {
  apiKey();
  const prompt = elements.prompt.value.trim();
  if (!prompt) throw new ApiError('请填写视频提示词。', 400, 'missing_prompt');
  if (prompt.length > 12000) throw new ApiError('提示词不能超过 12000 个字符。', 400, 'prompt_too_long');
  const duration = Number(elements.duration.value);
  if (!Number.isInteger(duration) || duration < 1 || duration > 15) throw new ApiError('视频时长必须在 1 到 15 秒之间。');
  const seed = Number(elements.seed.value);
  if (!Number.isInteger(seed)) throw new ApiError('随机种子必须是整数。');
  const audioDuration = elements.audioTotal.dataset.duration;
  if (audioDuration === 'invalid') throw new ApiError('参考音频无法读取，请更换文件。');
  if (Number(audioDuration || 0) > 15) throw new ApiError('两段参考音频合计不能超过 15 秒。');
  return { prompt, duration, seed };
}

function hasMediaFiles() {
  return fileFields.some(([, input]) => input.files?.length);
}

function buildRequestBody(values) {
  const common = {
    model: 'mojiang-h3-ref2va',
    prompt: values.prompt,
    duration: values.duration,
    resolution: elements.resolution.value,
    ratio: elements.ratio.value,
    seed: values.seed,
  };
  if (!hasMediaFiles()) {
    return { body: JSON.stringify(common), headers: { 'Content-Type': 'application/json' } };
  }
  const formData = new FormData();
  for (const [key, value] of Object.entries(common)) formData.set(key, String(value));
  for (const [field, input] of fileFields) {
    if (input.files?.[0]) formData.set(field, input.files[0], input.files[0].name);
  }
  return { body: formData, headers: {} };
}

async function submitGeneration(event) {
  event.preventDefault();
  setFormMessage();
  elements.submitButton.disabled = true;
  elements.submitButton.querySelector('.button-label').textContent = '正在创建任务…';
  stopPolling();
  releaseVideoUrl();
  try {
    const values = validateForm();
    const request = buildRequestBody(values);
    updateTaskUi({ status: 'queued', progress: 0, title: '正在提交任务', description: '正在把配置安全地发送到 H3 网关。' });
    const payload = await apiRequest('/api/videos', { method: 'POST', ...request });
    setRawResponse(payload);
    const taskId = extractTaskId(payload);
    if (!taskId) throw new ApiError('接口已响应，但没有返回任务 ID。', 502, 'missing_task_id');
    setTaskId(taskId);
    state.startedAt = Date.now();
    state.finalizationAttempts = 0;
    beginElapsedTimer();
    const status = extractStatus(payload);
    updateTaskUi({ status, progress: extractProgress(payload) });
    saveHistory({ id: taskId, status, prompt: values.prompt.slice(0, 100), createdAt: new Date().toISOString() });
    setFormMessage('任务创建成功，正在自动查询进度。', 'success');
    schedulePoll(1200);
  } catch (error) {
    stopPolling();
    stopElapsedTimer();
    updateTaskUi({ status: 'failed', progress: 0, title: '任务未创建', description: errorDescription(error) });
    setFormMessage(errorDescription(error));
  } finally {
    elements.submitButton.disabled = false;
    elements.submitButton.querySelector('.button-label').textContent = '开始生成视频';
  }
}

async function loadVideo({ silent = false } = {}) {
  if (!state.taskId) throw new ApiError('当前没有可加载的任务。');
  elements.loadVideo.disabled = true;
  if (!silent) setFormMessage('正在加载视频文件…', 'success');
  try {
    const blob = await apiRequest(`/api/videos/${encodeURIComponent(state.taskId)}/content`, { expectBlob: true });
    if (!blob.type.startsWith('video/') && blob.size < 32) throw new ApiError('返回内容不是有效的视频文件。', 502, 'invalid_video');
    releaseVideoUrl();
    state.videoUrl = URL.createObjectURL(blob);
    elements.video.src = state.videoUrl;
    elements.video.hidden = false;
    elements.videoEmpty.hidden = true;
    elements.openVideo.disabled = false;
    elements.downloadVideo.disabled = false;
    if (!silent) setFormMessage('视频加载完成。', 'success');
    return state.videoUrl;
  } finally {
    elements.loadVideo.disabled = !state.taskId;
  }
}

function resumeTask(item) {
  try {
    apiKey();
  } catch (error) {
    setFormMessage('请先填写 API 密钥，再恢复任务查询。');
    elements.apiKey.focus();
    return;
  }
  stopPolling();
  releaseVideoUrl();
  setTaskId(item.id);
  state.startedAt = item.createdAt ? new Date(item.createdAt).getTime() : Date.now();
  if (!Number.isFinite(state.startedAt)) state.startedAt = Date.now();
  state.finalizationAttempts = 0;
  beginElapsedTimer();
  updateTaskUi({ status: item.status || 'processing', progress: 0, title: '正在恢复任务', description: '正在用任务 ID 查询 H3 状态。' });
  pollTask({ manual: true });
}

async function verifyKey() {
  elements.testKey.disabled = true;
  setFormMessage();
  try {
    const payload = await apiRequest('/api/models');
    const hasModel = Array.isArray(payload?.data) && payload.data.some((model) => model.id === 'mojiang-h3-ref2va');
    setFormMessage(hasModel ? 'API 密钥有效，H3 模型可用。' : 'API 密钥有效，但模型列表中未找到 H3。', hasModel ? 'success' : 'error');
  } catch (error) {
    setFormMessage(errorDescription(error));
  } finally {
    elements.testKey.disabled = false;
  }
}

function resetForm() {
  const key = elements.apiKey.value;
  elements.form.reset();
  elements.apiKey.value = key;
  elements.promptCount.textContent = '0 / 12000';
  elements.audioTotal.dataset.duration = '0';
  elements.audioTotal.textContent = '参考音频总时长：0 秒';
  elements.audioTotal.classList.remove('invalid');
  setFormMessage();
}

async function checkLocalHealth() {
  try {
    const response = await fetch('/api/health');
    if (!response.ok) throw new Error('health failed');
    const payload = await response.json();
    elements.localStatus.classList.remove('offline');
    elements.localStatus.lastChild.textContent = '本地代理已连接';
    elements.gatewayLabel.textContent = `H3 网关：${payload.gateway}`;
  } catch {
    elements.localStatus.classList.add('offline');
    elements.localStatus.lastChild.textContent = '本地代理异常';
    elements.gatewayLabel.textContent = '无法读取本地代理状态';
  }
}

elements.form.addEventListener('submit', submitGeneration);
elements.prompt.addEventListener('input', () => { elements.promptCount.textContent = `${elements.prompt.value.length} / 12000`; });
elements.toggleKey.addEventListener('click', () => {
  const hidden = elements.apiKey.type === 'password';
  elements.apiKey.type = hidden ? 'text' : 'password';
  elements.toggleKey.textContent = hidden ? '隐藏' : '显示';
  elements.toggleKey.setAttribute('aria-label', hidden ? '隐藏 API 密钥' : '显示 API 密钥');
});
elements.testKey.addEventListener('click', verifyKey);
elements.resetButton.addEventListener('click', resetForm);
elements.audio1.addEventListener('change', updateAudioTotal);
elements.audio2.addEventListener('change', updateAudioTotal);
elements.refreshTask.addEventListener('click', () => pollTask({ manual: true }));
elements.stopPolling.addEventListener('click', () => stopPolling(true));
elements.copyTaskId.addEventListener('click', async () => {
  if (!state.taskId) return;
  await navigator.clipboard.writeText(state.taskId);
  setFormMessage('任务 ID 已复制。', 'success');
});
elements.loadVideo.addEventListener('click', () => loadVideo().catch((error) => setFormMessage(errorDescription(error))));
elements.openVideo.addEventListener('click', () => { if (state.videoUrl) window.open(state.videoUrl, '_blank', 'noopener'); });
elements.downloadVideo.addEventListener('click', () => {
  if (!state.videoUrl || !state.taskId) return;
  const link = document.createElement('a');
  link.href = state.videoUrl;
  link.download = `${state.taskId}.mp4`;
  link.click();
});
elements.clearHistory.addEventListener('click', () => {
  localStorage.removeItem(HISTORY_KEY);
  renderHistory();
});
window.addEventListener('beforeunload', () => {
  stopPolling();
  stopElapsedTimer();
  releaseVideoUrl();
});

elements.audioTotal.dataset.duration = '0';
renderHistory();
checkLocalHealth();
