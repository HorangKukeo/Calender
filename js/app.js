// ==========================================
// Firebase Realtime Database
// ==========================================
const DB_URL = 'https://horangcalender-default-rtdb.firebaseio.com/data.json';
const ADMIN_KEY = 'horangsik2';
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const SAVE_RETRY_LIMIT = 4;
const VALID_STATUSES = new Set(['NONE', 'IMPORTANT', 'PENDING', 'COMPLETED']);
const VALID_REPEAT_TYPES = new Set(['WEEKLY', 'BIWEEKLY', 'MONTHLY']);
const HISTORY_STORAGE_KEY = 'calendar_change_history_v2';
const LAST_SAVE_STORAGE_KEY = 'calendar_last_save_v2';
const HISTORY_LIMIT = 20;
const TRASH_RETENTION_DAYS = 30;

let db = createEmptyDatabase();
let currentFilter = {
    type: 'ALL', schoolId: null, schoolIds: [], studentId: null,
    query: '', status: 'ALL', dateFrom: '', dateTo: ''
};
let calendar;
let isSaving = false;
let isTouchScrolling = false;
let pendingImport = null;

document.addEventListener('touchstart', () => { isTouchScrolling = false; }, { passive: true });
document.addEventListener('touchmove', () => { isTouchScrolling = true; }, { passive: true });

function createEmptyDatabase() {
    return { schools: [], students: [], schedules: [], memos: [], trash: [] };
}

function asArray(value) {
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') return Object.values(value);
    return [];
}

function cleanText(value, maxLength = 1000) {
    return String(value ?? '').trim().slice(0, maxLength);
}

function isValidId(value) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
}

function isValidDateString(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isValidScheduleDate(value) {
    if (typeof value !== 'string') return false;
    const [datePart, timePart] = value.split('T');
    if (!isValidDateString(datePart)) return false;
    return !timePart || /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(timePart);
}

function normalizeColor(value) {
    return /^#[0-9a-fA-F]{6}$/.test(String(value || '')) ? String(value) : '#4F46E5';
}

function normalizeTimestamp(value) {
    if (!value || Number.isNaN(Date.parse(value))) return null;
    return new Date(value).toISOString();
}

function sanitizeMemoHtml(value) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(`<body>${String(value ?? '')}</body>`, 'text/html');
    const allowedTags = new Set(['P', 'DIV', 'BR', 'B', 'I', 'U', 'STRONG', 'EM', 'FONT', 'SPAN', 'UL', 'OL', 'LI']);
    const removeEntirely = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH']);

    [...doc.body.querySelectorAll('*')].forEach(element => {
        if (removeEntirely.has(element.tagName)) {
            element.remove();
            return;
        }
        if (!allowedTags.has(element.tagName)) {
            element.replaceWith(...element.childNodes);
            return;
        }

        [...element.attributes].forEach(attribute => {
            const name = attribute.name.toLowerCase();
            const valueText = attribute.value;
            const isFontAttribute = element.tagName === 'FONT' &&
                ((name === 'color' && /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{1,20})$/.test(valueText)) ||
                 (name === 'size' && /^[1-7]$/.test(valueText)));
            const isSafeStyle = element.tagName === 'SPAN' && name === 'style' && valueText
                .split(';')
                .filter(Boolean)
                .every(rule => /^\s*(color|font-size|font-weight|font-style|text-decoration)\s*:\s*[#(),.%\w\s-]+\s*$/i.test(rule));
            if (!isFontAttribute && !isSafeStyle) element.removeAttribute(attribute.name);
        });
    });

    return doc.body.innerHTML.slice(0, 50000);
}

function uniqueById(records) {
    const seen = new Set();
    return records.filter(record => {
        if (seen.has(record.id)) return false;
        seen.add(record.id);
        return true;
    });
}

function normalizeDatabase(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const normalized = createEmptyDatabase();

    normalized.schools = uniqueById(asArray(source.schools).flatMap(item => {
        if (!item || !isValidId(item.id)) return [];
        const name = cleanText(item.name, 80);
        if (!name) return [];
        return [{
            id: item.id,
            name,
            color: normalizeColor(item.color),
            createdAt: normalizeTimestamp(item.createdAt),
            updatedAt: normalizeTimestamp(item.updatedAt)
        }];
    }));

    normalized.students = uniqueById(asArray(source.students).flatMap(item => {
        if (!item || !isValidId(item.id)) return [];
        const name = cleanText(item.name, 80);
        if (!name) return [];
        const affiliations = [...new Set(asArray(item.schoolIds).filter(isValidId))];
        return [{
            id: item.id,
            name,
            schoolIds: affiliations,
            createdAt: normalizeTimestamp(item.createdAt),
            updatedAt: normalizeTimestamp(item.updatedAt)
        }];
    }));

    normalized.schedules = uniqueById(asArray(source.schedules).flatMap(item => {
        if (!item || !isValidId(item.id) || !isValidScheduleDate(item.start)) return [];
        const title = cleanText(item.title, 120);
        const type = ['COMMON', 'SCHOOL', 'STUDENT'].includes(item.type) ? item.type : 'COMMON';
        const targetId = type === 'COMMON' ? null : item.targetId;
        if (!title || (type !== 'COMMON' && !isValidId(targetId))) return [];
        return [{
            id: item.id,
            title,
            start: item.start,
            end: item.end && isValidScheduleDate(item.end) ? item.end : null,
            durationDays: Number.isInteger(Number(item.durationDays))
                ? Math.min(365, Math.max(1, Number(item.durationDays)))
                : calculateDurationDays(item.start, item.end, !item.start.includes('T')),
            type,
            targetId,
            memo: cleanText(item.memo, 10000),
            status: VALID_STATUSES.has(item.status) ? item.status : 'NONE',
            seriesId: isValidId(item.seriesId) ? item.seriesId : null,
            occurrenceIndex: Number.isInteger(Number(item.occurrenceIndex)) ? Math.max(0, Number(item.occurrenceIndex)) : 0,
            repeatType: VALID_REPEAT_TYPES.has(item.repeatType) ? item.repeatType : null,
            createdAt: normalizeTimestamp(item.createdAt),
            updatedAt: normalizeTimestamp(item.updatedAt)
        }];
    }));

    normalized.memos = uniqueById(asArray(source.memos).flatMap(item => {
        if (!item || !isValidId(item.id)) return [];
        const createdAt = Number.isNaN(Date.parse(item.createdAt)) ? new Date(0).toISOString() : new Date(item.createdAt).toISOString();
        const updatedAt = Number.isNaN(Date.parse(item.updatedAt)) ? createdAt : new Date(item.updatedAt).toISOString();
        return [{
            id: item.id,
            title: cleanText(item.title, 120) || '제목 없음',
            content: sanitizeMemoHtml(item.content),
            createdAt,
            updatedAt
        }];
    }));

    const now = Date.now();
    normalized.trash = uniqueById(asArray(source.trash).flatMap(item => {
        if (!item || !isValidId(item.id)) return [];
        const deletedAt = normalizeTimestamp(item.deletedAt);
        const expiresAt = normalizeTimestamp(item.expiresAt);
        if (!deletedAt || !expiresAt || Date.parse(expiresAt) <= now) return [];
        const payload = normalizeDatabase(item.payload || {});
        payload.trash = [];
        if (!payload.schools.length && !payload.students.length && !payload.schedules.length) return [];
        return [{
            id: item.id,
            kind: ['school', 'student', 'schedule', 'bulk', 'merge'].includes(item.kind) ? item.kind : 'bulk',
            label: cleanText(item.label, 160) || '삭제된 데이터',
            deletedAt,
            expiresAt,
            payload
        }];
    }));

    return normalized;
}

function cloneDatabase(value) {
    return JSON.parse(JSON.stringify(value));
}

function escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = String(value ?? '');
    return div.innerHTML;
}

function generateId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 11)}`;
}

function showToast(message, kind = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast toast-${kind}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

function showUndoToast(message, trashId) {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = 'toast toast-success toast-action';
    const label = document.createElement('span');
    label.textContent = message;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '실행 취소';
    button.addEventListener('click', async () => {
        button.disabled = true;
        await restoreTrashItem(trashId, false);
        toast.remove();
    });
    toast.append(label, button);
    container.appendChild(toast);
    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 10000);
}

function formatDateTime(value) {
    if (!value) return '기록 없음';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '기록 없음';
    return date.toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });
}

function setSaveStatus(state, message) {
    const element = document.getElementById('saveStatus');
    if (!element) return;
    element.dataset.state = state;
    element.textContent = `● ${message}`;
    const mobileIndicator = document.querySelector('.mobile-status-dot');
    if (mobileIndicator) {
        mobileIndicator.dataset.state = state;
        mobileIndicator.title = message;
    }
}

function getLocalHistory() {
    try {
        const parsed = JSON.parse(localStorage.getItem(HISTORY_STORAGE_KEY) || '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch (_error) {
        return [];
    }
}

function recordLocalHistory(snapshot, summary) {
    const entry = {
        id: generateId(),
        createdAt: new Date().toISOString(),
        summary: cleanText(summary, 160) || '데이터 변경 전 상태',
        snapshot: cloneDatabase(snapshot)
    };
    let history = [entry, ...getLocalHistory()].slice(0, HISTORY_LIMIT);
    try {
        localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history));
    } catch (_error) {
        history = history.slice(0, 5);
        try { localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history)); } catch (_ignored) { /* 저장 공간 부족 */ }
    }
}

function createTrashEntry(kind, label, payload) {
    const deletedAt = new Date();
    const expiresAt = new Date(deletedAt.getTime() + TRASH_RETENTION_DAYS * 86400000);
    return {
        id: generateId(),
        kind,
        label: cleanText(label, 160),
        deletedAt: deletedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        payload: { ...createEmptyDatabase(), ...cloneDatabase(payload), trash: [] }
    };
}

function upsertRecords(target, incoming) {
    const map = new Map(target.map(item => [item.id, item]));
    incoming.forEach(item => map.set(item.id, cloneDatabase(item)));
    return [...map.values()];
}

async function restoreTrashItem(trashId, askConfirmation = true) {
    const item = db.trash.find(entry => entry.id === trashId);
    if (!item) return showToast('휴지통 항목을 찾을 수 없습니다.', 'error');
    if (askConfirmation && !confirm(`'${item.label}' 항목을 복원하시겠습니까? 같은 ID의 현재 데이터가 있으면 휴지통 내용으로 복원됩니다.`)) return;
    const success = await executeDBUpdate(draft => {
        const current = draft.trash.find(entry => entry.id === trashId);
        if (!current) throw new Error('이미 복원되었거나 삭제된 휴지통 항목입니다.');
        for (const key of ['schools', 'students', 'schedules', 'memos']) {
            draft[key] = upsertRecords(draft[key], current.payload[key] || []);
        }
        draft.trash = draft.trash.filter(entry => entry.id !== trashId);
    }, { summary: `휴지통 복원: ${item.label}` });
    if (success) {
        showToast(`'${item.label}' 항목을 복원했습니다.`, 'success');
        renderSafetyCenter();
    }
}

async function permanentlyDeleteTrashItem(trashId) {
    const item = db.trash.find(entry => entry.id === trashId);
    if (!item || !confirm(`'${item.label}' 항목을 휴지통에서도 영구 삭제하시겠습니까?`)) return;
    const success = await executeDBUpdate(draft => {
        draft.trash = draft.trash.filter(entry => entry.id !== trashId);
    }, { summary: `휴지통 영구 삭제: ${item.label}` });
    if (success) renderSafetyCenter();
}

function openSafetyCenter() {
    renderSafetyCenter();
    openModal('safetyCenterModal');
}

function switchSafetyTab(tab) {
    const isTrash = tab === 'trash';
    document.getElementById('trashTabButton').classList.toggle('active', isTrash);
    document.getElementById('historyTabButton').classList.toggle('active', !isTrash);
    document.getElementById('trashTabPanel').classList.toggle('active', isTrash);
    document.getElementById('historyTabPanel').classList.toggle('active', !isTrash);
}

function renderSafetyCenter() {
    const trashList = document.getElementById('trashList');
    const historyList = document.getElementById('historyList');
    if (!trashList || !historyList) return;
    trashList.innerHTML = db.trash.length ? [...db.trash].sort((a, b) => b.deletedAt.localeCompare(a.deletedAt)).map(item =>
        `<li><span class="item-main"><b>${escapeHtml(item.label)}</b><small>삭제: ${escapeHtml(formatDateTime(item.deletedAt))}<br>자동 정리: ${escapeHtml(formatDateTime(item.expiresAt))}</small></span>` +
        `<span class="manage-actions"><button class="edit-btn" onclick="restoreTrashItem('${item.id}')">복원</button>` +
        `<button class="delete-btn" onclick="permanentlyDeleteTrashItem('${item.id}')">영구 삭제</button></span></li>`
    ).join('') : '<li class="empty-list">휴지통이 비어 있습니다.</li>';

    const history = getLocalHistory();
    historyList.innerHTML = history.length ? history.map(item =>
        `<li><span class="item-main"><b>${escapeHtml(item.summary)}</b><small>${escapeHtml(formatDateTime(item.createdAt))}</small></span>` +
        `<button class="edit-btn" onclick="restoreHistorySnapshot('${item.id}')">이 상태로 복원</button></li>`
    ).join('') : '<li class="empty-list">이 PC에 저장된 변경 이력이 없습니다.</li>';
}

async function restoreHistorySnapshot(historyId) {
    const entry = getLocalHistory().find(item => item.id === historyId);
    if (!entry) return showToast('변경 이력을 찾을 수 없습니다.', 'error');
    if (!confirm(`${formatDateTime(entry.createdAt)}의 상태로 전체 데이터를 복원하시겠습니까? 현재 상태도 변경 이력에 남습니다.`)) return;
    const success = await executeDBUpdate(draft => {
        const restored = normalizeDatabase(entry.snapshot);
        for (const key of Object.keys(createEmptyDatabase())) draft[key] = cloneDatabase(restored[key]);
    }, { summary: `변경 이력 복원 전: ${entry.summary}` });
    if (success) {
        showToast('선택한 변경 이력으로 복원했습니다.', 'success');
        renderSafetyCenter();
    }
}

function toggleSidebar(forceOpen) {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    const shouldOpen = typeof forceOpen === 'boolean' ? forceOpen : !sidebar.classList.contains('active');
    sidebar.classList.toggle('active', shouldOpen);
    overlay.style.display = shouldOpen ? 'block' : 'none';
}

async function fetchDatabaseSnapshot() {
    const response = await fetch(DB_URL, { headers: { 'X-Firebase-ETag': 'true' }, cache: 'no-store' });
    if (!response.ok) throw new Error(`데이터 로드 실패 (${response.status})`);
    return { data: normalizeDatabase(await response.json()), etag: response.headers.get('ETag') };
}

async function fetchLatestData({ notify = false } = {}) {
    setSaveStatus('loading', '서버 데이터 불러오는 중');
    try {
        const snapshot = await fetchDatabaseSnapshot();
        db = snapshot.data;
        let lastSave = null;
        try { lastSave = localStorage.getItem(LAST_SAVE_STORAGE_KEY); } catch (_error) { /* 저장소 접근 불가 */ }
        setSaveStatus('saved', lastSave ? `연결됨 · 마지막 저장 ${formatDateTime(lastSave)}` : '서버 연결 완료');
        return true;
    } catch (error) {
        console.error('Firebase 로드 실패:', error);
        setSaveStatus(navigator.onLine ? 'error' : 'offline', navigator.onLine ? '서버 연결 실패' : '인터넷 연결 끊김');
        if (notify) showToast('서버 데이터를 불러오지 못했습니다. 네트워크를 확인해주세요.', 'error');
        return false;
    }
}

async function writeDatabase(data, etag) {
    const headers = { 'Content-Type': 'application/json' };
    if (etag) headers['If-Match'] = etag;
    return fetch(DB_URL, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ ...data, adminKey: ADMIN_KEY })
    });
}

// 최신 서버 데이터를 기준으로 수정하고 ETag 충돌 시 다시 적용한다.
async function executeDBUpdate(mutator, { summary = '데이터 변경' } = {}) {
    if (isSaving) {
        showToast('이전 저장이 끝난 뒤 다시 시도해주세요.', 'error');
        return false;
    }

    isSaving = true;
    document.body.classList.add('is-saving');
    setSaveStatus('saving', '저장 중');
    try {
        for (let attempt = 0; attempt < SAVE_RETRY_LIMIT; attempt += 1) {
            const snapshot = await fetchDatabaseSnapshot();
            const draft = cloneDatabase(snapshot.data);
            const result = mutator(draft);
            if (result === false) {
                setSaveStatus('saved', '변경 없음');
                return false;
            }

            const cleanDraft = normalizeDatabase(draft);
            const response = await writeDatabase(cleanDraft, snapshot.etag);
            if (response.status === 412) {
                setSaveStatus('conflict', '다른 기기 변경 감지 · 안전하게 재시도 중');
                continue;
            }
            if (!response.ok) throw new Error(`데이터 저장 실패 (${response.status})`);

            recordLocalHistory(snapshot.data, summary);
            db = cleanDraft;
            const savedAt = new Date().toISOString();
            try { localStorage.setItem(LAST_SAVE_STORAGE_KEY, savedAt); } catch (_error) { /* 저장 상태 표시는 계속 제공 */ }
            setSaveStatus('saved', `저장 완료 · ${formatDateTime(savedAt)}`);
            updateUI();
            renderCalendar();
            return true;
        }
        throw new Error('다른 기기에서 연속으로 수정하여 저장 충돌이 발생했습니다.');
    } catch (error) {
        console.error(error);
        await fetchLatestData();
        updateUI();
        renderCalendar();
        setSaveStatus(navigator.onLine ? 'error' : 'offline', navigator.onLine ? '저장 실패' : '인터넷 연결 끊김 · 저장 안 됨');
        showToast(error.message || '데이터 저장 중 오류가 발생했습니다.', 'error');
        return false;
    } finally {
        isSaving = false;
        document.body.classList.remove('is-saving');
    }
}

function waitForFullCalendar(timeoutMs = 5000) {
    if (typeof FullCalendar !== 'undefined') return Promise.resolve(true);
    return new Promise(resolve => {
        const startedAt = Date.now();
        const timer = setInterval(() => {
            if (typeof FullCalendar !== 'undefined' || Date.now() - startedAt >= timeoutMs) {
                clearInterval(timer);
                resolve(typeof FullCalendar !== 'undefined');
            }
        }, 100);
    });
}

document.addEventListener('DOMContentLoaded', async () => {
    ['schedTitle', 'schedTime', 'schedStatus', 'schedMemo'].forEach(id => {
        document.getElementById(id)?.addEventListener('input', () => updateScheduleWarnings('add'));
    });
    ['editTitle', 'editTime', 'editStatus', 'editMemo'].forEach(id => {
        document.getElementById(id)?.addEventListener('input', () => updateScheduleWarnings('edit'));
    });
    document.getElementById('schedDate')?.addEventListener('change', () => {
        updateDurationPreview('add');
        updateScheduleWarnings('add');
    });
    document.getElementById('editDate')?.addEventListener('change', () => {
        updateDurationPreview('edit');
        updateScheduleWarnings('edit');
    });
    const loaded = await fetchLatestData({ notify: true });
    updateUI();
    if (!loaded) showToast('빈 화면으로 시작했습니다. 연결 복구 후 새로고침해주세요.', 'error');

    if (!await waitForFullCalendar()) {
        showToast('달력 모듈을 불러오지 못했습니다. 데이터 관리 기능은 계속 사용할 수 있습니다.', 'error');
        return;
    }

    const calendarEl = document.getElementById('calendar');
    calendar = new FullCalendar.Calendar(calendarEl, {
        initialView: 'dayGridMonth',
        locale: 'ko',
        headerToolbar: { left: 'prev,next today', center: 'title', right: 'dayGridMonth,timeGridWeek,timeGridDay' },
        buttonText: { today: '오늘', month: '월별', week: '주간', day: '일별' },
        height: window.innerWidth <= 768 ? 'auto' : '100%',
        editable: true,
        eventDurationEditable: true,
        fixedMirrorParent: document.body,
        events: (fetchInfo, successCallback) => successCallback(buildCalendarEvents(fetchInfo)),
        dayMaxEvents: false,
        dayMaxEventRows: false,
        lazyFetching: true,
        progressiveEventRendering: true,
        rerenderDelay: 24,
        dateClick: info => {
            if (!isTouchScrolling) openScheduleModal(info.dateStr);
        },
        eventClick: info => openScheduleEditor(info.event.id),
        eventDrop: info => persistCalendarMove(info),
        eventResize: info => persistCalendarMove(info, true)
    });
    calendar.render();
    updateDurationPreview('add');
    updateDurationPreview('edit');
});

window.addEventListener('online', () => setSaveStatus('saved', '인터넷 연결 복구됨'));
window.addEventListener('offline', () => setSaveStatus('offline', '인터넷 연결 끊김 · 저장 안 됨'));

function buildCalendarEvents(fetchInfo = null) {
    let filteredSchedules = db.schedules || [];
    const schoolsById = new Map(db.schools.map(school => [school.id, school]));
    const studentsById = new Map(db.students.map(student => [student.id, student]));

    if (fetchInfo?.startStr && fetchInfo?.endStr) {
        const visibleStart = fetchInfo.startStr.slice(0, 10);
        const visibleEnd = fetchInfo.endStr.slice(0, 10);
        filteredSchedules = filteredSchedules.filter(schedule => {
            const scheduleStart = schedule.start.split('T')[0];
            return scheduleStart < visibleEnd && getScheduleLastDate(schedule) >= visibleStart;
        });
    }

    if (currentFilter.type === 'SCHOOL') {
        const targetId = currentFilter.schoolId;
        const schoolStudents = new Set(db.students.filter(student => student.schoolIds.includes(targetId)).map(student => student.id));
        filteredSchedules = filteredSchedules.filter(schedule =>
            schedule.type === 'COMMON' ||
            (schedule.type === 'SCHOOL' && schedule.targetId === targetId) ||
            (schedule.type === 'STUDENT' && schoolStudents.has(schedule.targetId))
        );
    } else if (currentFilter.type === 'STUDENT') {
        const student = db.students.find(item => item.id === currentFilter.studentId);
        const studentSchools = student?.schoolIds || [];
        filteredSchedules = filteredSchedules.filter(schedule =>
            schedule.type === 'COMMON' ||
            (schedule.type === 'STUDENT' && schedule.targetId === currentFilter.studentId) ||
            (schedule.type === 'SCHOOL' && studentSchools.includes(schedule.targetId))
        );
    } else if (currentFilter.type === 'MULTI_SCHOOL') {
        const selectedSchoolIds = new Set(currentFilter.schoolIds);
        const selectedStudentIds = new Set(db.students
            .filter(student => student.schoolIds.some(id => selectedSchoolIds.has(id)))
            .map(student => student.id));
        filteredSchedules = filteredSchedules.filter(schedule =>
            schedule.type === 'COMMON' ||
            (schedule.type === 'SCHOOL' && selectedSchoolIds.has(schedule.targetId)) ||
            (schedule.type === 'STUDENT' && selectedStudentIds.has(schedule.targetId))
        );
    }

    const query = cleanText(currentFilter.query, 120).toLocaleLowerCase();
    if (query) {
        filteredSchedules = filteredSchedules.filter(schedule =>
            `${schedule.title} ${schedule.memo || ''}`.toLocaleLowerCase().includes(query));
    }
    if (VALID_STATUSES.has(currentFilter.status)) {
        filteredSchedules = filteredSchedules.filter(schedule => schedule.status === currentFilter.status);
    }
    if (isValidDateString(currentFilter.dateFrom)) {
        filteredSchedules = filteredSchedules.filter(schedule => getScheduleLastDate(schedule) >= currentFilter.dateFrom);
    }
    if (isValidDateString(currentFilter.dateTo)) {
        filteredSchedules = filteredSchedules.filter(schedule => schedule.start.split('T')[0] <= currentFilter.dateTo);
    }

    return filteredSchedules.map(schedule => {
        let color = '#4F46E5';
        let hasMissingTarget = false;
        if (schedule.type === 'SCHOOL') {
            const school = schoolsById.get(schedule.targetId);
            color = school?.color || '#6B7280';
            hasMissingTarget = !school;
        } else if (schedule.type === 'STUDENT') {
            const student = studentsById.get(schedule.targetId);
            color = schoolsById.get(student?.schoolIds?.[0])?.color || '#F59E0B';
            hasMissingTarget = !student;
        }

        const statusConfig = {
            COMPLETED: ['✅ ', 'event-completed'],
            IMPORTANT: ['⭐ ', 'event-important'],
            PENDING: ['⏳ ', 'event-pending'],
            NONE: ['', '']
        }[schedule.status || 'NONE'];
        return {
            id: schedule.id,
            title: `${hasMissingTarget ? '⚠️ ' : ''}${statusConfig[0]}${schedule.title}`,
            start: schedule.start,
            end: schedule.end,
            backgroundColor: color,
            borderColor: color,
            classNames: statusConfig[1] ? [statusConfig[1]] : []
        };
    });
}

function toLocalDateTime(date) {
    if (!date) return null;
    const offset = date.getTimezoneOffset() * 60000;
    return new Date(date.getTime() - offset).toISOString().slice(0, -1);
}

function calculateDurationDays(startValue, endValue, allDay) {
    if (!startValue || !endValue) return 1;
    const startDate = new Date(`${startValue.split('T')[0]}T00:00:00Z`);
    const endDate = new Date(`${endValue.split('T')[0]}T00:00:00Z`);
    const dateDifference = Math.round((endDate - startDate) / 86400000);
    return Math.min(365, Math.max(1, allDay ? dateDifference : dateDifference + 1));
}

async function persistCalendarMove(info, isResize = false) {
    const startValue = toLocalDateTime(info.event.start);
    const endValue = toLocalDateTime(info.event.end);
    const success = await executeDBUpdate(draft => {
        const schedule = draft.schedules.find(item => item.id === info.event.id);
        if (!schedule) throw new Error('이 일정은 다른 기기에서 이미 삭제되었습니다.');
        schedule.start = info.event.allDay ? startValue.split('T')[0] : startValue;
        schedule.end = endValue ? (info.event.allDay ? endValue.split('T')[0] : endValue) : null;
        if (isResize) schedule.durationDays = calculateDurationDays(startValue, endValue, info.event.allDay);
        schedule.updatedAt = new Date().toISOString();
    }, { summary: isResize ? '달력에서 일정 기간 변경' : '달력에서 일정 이동' });
    if (!success) info.revert();
    else showToast(isResize ? '일정 시간이 변경되었습니다.' : '일정이 이동되었습니다.', 'success');
}

function handleSchoolFilterChange() {
    const schoolId = document.getElementById('filter-school').value;
    currentFilter.type = schoolId === 'ALL' ? 'ALL' : 'SCHOOL';
    currentFilter.schoolId = schoolId === 'ALL' ? null : schoolId;
    currentFilter.schoolIds = [];
    currentFilter.studentId = null;
    const multiSelect = document.getElementById('filterSchoolsMulti');
    if (multiSelect) [...multiSelect.options].forEach(option => { option.selected = false; });
    updateFilterControls();
    renderCalendar();
}

function toggleStudentFilter(studentId) {
    const isCurrent = currentFilter.studentId === studentId;
    currentFilter.studentId = isCurrent ? null : studentId;
    currentFilter.type = isCurrent ? 'SCHOOL' : 'STUDENT';
    renderStudentFilterButtons();
    renderCalendar();
}

function applyAdvancedFilters() {
    const selectedSchoolIds = [...document.getElementById('filterSchoolsMulti').selectedOptions].map(option => option.value);
    currentFilter.query = document.getElementById('filterSearch').value;
    currentFilter.status = document.getElementById('filterStatus').value;
    currentFilter.dateFrom = document.getElementById('filterDateFrom').value;
    currentFilter.dateTo = document.getElementById('filterDateTo').value;
    currentFilter.schoolIds = selectedSchoolIds;
    if (selectedSchoolIds.length) {
        currentFilter.type = 'MULTI_SCHOOL';
        currentFilter.schoolId = null;
        currentFilter.studentId = null;
        document.getElementById('filter-school').value = 'ALL';
    } else if (currentFilter.type === 'MULTI_SCHOOL') {
        currentFilter.type = 'ALL';
    }
    renderStudentFilterButtons();
    renderCalendar(120);
}

function clearAdvancedFilters() {
    currentFilter.query = '';
    currentFilter.status = 'ALL';
    currentFilter.dateFrom = '';
    currentFilter.dateTo = '';
    currentFilter.schoolIds = [];
    if (currentFilter.type === 'MULTI_SCHOOL') currentFilter.type = 'ALL';
    document.getElementById('filterSearch').value = '';
    document.getElementById('filterStatus').value = 'ALL';
    document.getElementById('filterDateFrom').value = '';
    document.getElementById('filterDateTo').value = '';
    [...document.getElementById('filterSchoolsMulti').options].forEach(option => { option.selected = false; });
    renderCalendar();
}

function updateStudentSelect(mode) {
    const schoolSelect = document.getElementById(mode === 'add' ? 'schedTargetSchool' : 'editTargetSchool');
    const studentSelect = document.getElementById(mode === 'add' ? 'schedTargetStudent' : 'editTargetStudent');
    const previousValue = studentSelect.value;
    const schoolId = schoolSelect.value;
    if (schoolId === 'COMMON') {
        studentSelect.innerHTML = '<option value="ALL">전체 공통 적용</option>';
        studentSelect.disabled = true;
        updateScheduleWarnings(mode);
        return;
    }

    studentSelect.disabled = false;
    const options = db.students
        .filter(student => student.schoolIds.includes(schoolId))
        .map(student => `<option value="${student.id}">[학생] ${escapeHtml(student.name)}</option>`)
        .join('');
    studentSelect.innerHTML = `<option value="ALL">해당 그룹 전체 대상</option>${options}`;
    if ([...studentSelect.options].some(option => option.value === previousValue)) studentSelect.value = previousValue;
    updateScheduleWarnings(mode);
}

function addDays(dateString, days) {
    const [year, month, day] = dateString.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day + days));
    return date.toISOString().slice(0, 10);
}

function addMonths(dateString, months) {
    const [year, month, day] = dateString.split('-').map(Number);
    const firstOfTarget = new Date(Date.UTC(year, month - 1 + months, 1));
    const lastDay = new Date(Date.UTC(firstOfTarget.getUTCFullYear(), firstOfTarget.getUTCMonth() + 1, 0)).getUTCDate();
    const date = new Date(Date.UTC(firstOfTarget.getUTCFullYear(), firstOfTarget.getUTCMonth(), Math.min(day, lastDay)));
    return date.toISOString().slice(0, 10);
}

function daysBetween(startDate, endDate) {
    if (!isValidDateString(startDate) || !isValidDateString(endDate)) return null;
    const start = new Date(`${startDate}T00:00:00Z`);
    const end = new Date(`${endDate}T00:00:00Z`);
    return Math.round((end - start) / 86400000);
}

function getScheduleLastDate(schedule) {
    const startDate = schedule.start.split('T')[0];
    if (Number.isInteger(Number(schedule.durationDays))) return addDays(startDate, Number(schedule.durationDays) - 1);
    if (!schedule.end) return startDate;
    const endDate = schedule.end.split('T')[0];
    return schedule.start.includes('T') ? endDate : addDays(endDate, -1);
}

function getDurationDays(mode) {
    const input = document.getElementById(mode === 'add' ? 'schedDurationDays' : 'editDurationDays');
    const endInput = document.getElementById(mode === 'add' ? 'schedEndDate' : 'editEndDate');
    if (endInput && !endInput.validity.valid) {
        throw new Error(endInput.validationMessage || '올바른 종료일을 입력하세요.');
    }
    const days = Number.parseInt(input.value, 10);
    if (!Number.isInteger(days) || days < 1 || days > 365) {
        throw new Error('일정 기간은 1~365일 사이로 입력하세요.');
    }
    return days;
}

function setScheduleDuration(mode, days) {
    const input = document.getElementById(mode === 'add' ? 'schedDurationDays' : 'editDurationDays');
    input.value = String(days);
    syncDurationButtons(mode);
}

function syncDurationButtons(mode) {
    const inputId = mode === 'add' ? 'schedDurationDays' : 'editDurationDays';
    const input = document.getElementById(inputId);
    const value = Number.parseInt(input.value, 10);
    document.querySelectorAll(`.duration-preset[data-target="${inputId}"]`).forEach(button => {
        button.classList.toggle('active', Number(button.dataset.days) === value);
    });
    updateDurationPreview(mode);
    updateScheduleWarnings(mode);
}

function setDurationFromEndDate(mode) {
    const startInput = document.getElementById(mode === 'add' ? 'schedDate' : 'editDate');
    const endInput = document.getElementById(mode === 'add' ? 'schedEndDate' : 'editEndDate');
    const durationInput = document.getElementById(mode === 'add' ? 'schedDurationDays' : 'editDurationDays');
    const difference = daysBetween(startInput.value, endInput.value);
    if (difference === null || difference < 0 || difference >= 365) {
        const message = '종료일은 시작일부터 365일 이내여야 합니다.';
        endInput.setCustomValidity(message);
        document.getElementById(mode === 'add' ? 'schedDatePreview' : 'editDatePreview').textContent = message;
        return;
    }
    endInput.setCustomValidity('');
    durationInput.value = String(difference + 1);
    syncDurationButtons(mode);
}

function updateDurationPreview(mode) {
    const startInput = document.getElementById(mode === 'add' ? 'schedDate' : 'editDate');
    const durationInput = document.getElementById(mode === 'add' ? 'schedDurationDays' : 'editDurationDays');
    const endInput = document.getElementById(mode === 'add' ? 'schedEndDate' : 'editEndDate');
    const preview = document.getElementById(mode === 'add' ? 'schedDatePreview' : 'editDatePreview');
    if (!startInput || !durationInput || !endInput || !preview) return;
    const days = Number.parseInt(durationInput.value, 10);
    if (!isValidDateString(startInput.value) || !Number.isInteger(days) || days < 1 || days > 365) {
        preview.textContent = '시작일과 1~365일 사이의 기간을 입력하세요.';
        return;
    }
    const lastDate = addDays(startInput.value, days - 1);
    // 같은 값을 다시 쓰면 날짜의 연·월·일 입력 위치가 초기화될 수 있다.
    if (endInput.value !== lastDate) endInput.value = lastDate;
    endInput.setCustomValidity('');
    preview.textContent = days === 1
        ? `${startInput.value} 하루 일정`
        : `${startInput.value} ~ ${lastDate} · 총 ${days}일`;
}

function parseTimeInput(dateString, input, durationDays = 1) {
    if (!isValidDateString(dateString)) throw new Error('올바른 날짜를 입력하세요.');
    if (!Number.isInteger(durationDays) || durationDays < 1 || durationDays > 365) {
        throw new Error('일정 기간은 1~365일 사이로 입력하세요.');
    }
    if (!input) {
        return { start: dateString, end: durationDays > 1 ? addDays(dateString, durationDays) : null };
    }
    const match = input.match(/^\s*([01]\d|2[0-3]):([0-5]\d)(?:\s*-\s*([01]\d|2[0-3]):([0-5]\d))?\s*$/);
    if (!match) throw new Error('시간은 19:00 또는 19:00-22:00 형식으로 입력하세요.');

    const startTime = `${match[1]}:${match[2]}`;
    const start = `${dateString}T${startTime}:00`;
    const lastDate = addDays(dateString, durationDays - 1);
    if (!match[3]) {
        return { start, end: durationDays > 1 ? `${lastDate}T23:59:59` : null };
    }
    const endTime = `${match[3]}:${match[4]}`;
    const endDate = durationDays > 1 ? lastDate : (endTime <= startTime ? addDays(dateString, 1) : dateString);
    return { start, end: `${endDate}T${endTime}:00` };
}

function resolveTarget(schoolValue, studentValue) {
    if (schoolValue === 'COMMON') return { type: 'COMMON', targetId: null };
    if (!db.schools.some(item => item.id === schoolValue)) throw new Error('선택한 그룹을 찾을 수 없습니다.');
    if (studentValue === 'ALL') return { type: 'SCHOOL', targetId: schoolValue };
    const student = db.students.find(item => item.id === studentValue);
    if (!student || !student.schoolIds.includes(schoolValue)) throw new Error('선택한 학생의 소속 정보가 올바르지 않습니다.');
    return { type: 'STUDENT', targetId: studentValue };
}

function scheduleRange(schedule) {
    const allDay = !schedule.start.includes('T');
    const start = new Date(allDay ? `${schedule.start}T00:00:00Z` : schedule.start).getTime();
    let end;
    if (schedule.end) {
        end = new Date(allDay ? `${schedule.end}T00:00:00Z` : schedule.end).getTime();
    } else if (allDay) {
        end = new Date(`${addDays(schedule.start, 1)}T00:00:00Z`).getTime();
    } else {
        end = start + 60 * 60 * 1000;
    }
    return { start, end: Math.max(end, start + 1) };
}

function targetsOverlap(first, second) {
    if (first.type === 'COMMON' || second.type === 'COMMON') return true;
    if (first.type === second.type) return first.targetId === second.targetId;
    const schoolSchedule = first.type === 'SCHOOL' ? first : second.type === 'SCHOOL' ? second : null;
    const studentSchedule = first.type === 'STUDENT' ? first : second.type === 'STUDENT' ? second : null;
    if (!schoolSchedule || !studentSchedule) return false;
    const student = db.students.find(item => item.id === studentSchedule.targetId);
    return Boolean(student?.schoolIds.includes(schoolSchedule.targetId));
}

function findScheduleConflicts(candidate, excludedIds = new Set(), additional = []) {
    const candidateRange = scheduleRange(candidate);
    return [...db.schedules, ...additional].filter(existing => {
        if (excludedIds.has(existing.id) || existing.id === candidate.id) return false;
        const existingRange = scheduleRange(existing);
        const overlaps = candidateRange.start < existingRange.end && candidateRange.end > existingRange.start;
        const duplicate = candidate.title.toLocaleLowerCase() === existing.title.toLocaleLowerCase() &&
            candidate.start.split('T')[0] === existing.start.split('T')[0];
        return duplicate || (overlaps && targetsOverlap(candidate, existing));
    });
}

function updateScheduleWarnings(mode) {
    const warning = document.getElementById(mode === 'add' ? 'scheduleConflictWarning' : 'editConflictWarning');
    if (!warning) return;
    try {
        const title = cleanText(document.getElementById(mode === 'add' ? 'schedTitle' : 'editTitle').value, 120);
        const date = document.getElementById(mode === 'add' ? 'schedDate' : 'editDate').value;
        if (!title || !isValidDateString(date)) throw new Error('');
        const durationDays = getDurationDays(mode);
        const time = document.getElementById(mode === 'add' ? 'schedTime' : 'editTime').value.trim();
        const target = resolveTarget(
            document.getElementById(mode === 'add' ? 'schedTargetSchool' : 'editTargetSchool').value,
            document.getElementById(mode === 'add' ? 'schedTargetStudent' : 'editTargetStudent').value
        );
        const id = mode === 'edit' ? document.getElementById('editId').value : generateId();
        const candidate = { id, title, ...parseTimeInput(date, time, durationDays), durationDays, ...target };
        const excluded = new Set(mode === 'edit' ? [id] : []);
        const conflicts = findScheduleConflicts(candidate, excluded);
        if (!conflicts.length) {
            warning.style.display = 'none';
            warning.textContent = '';
            return;
        }
        warning.style.display = 'block';
        warning.textContent = `겹치거나 중복될 수 있는 일정 ${conflicts.length}개: ${conflicts.slice(0, 3).map(item => item.title).join(', ')}${conflicts.length > 3 ? ' 외' : ''}`;
    } catch (_error) {
        warning.style.display = 'none';
        warning.textContent = '';
    }
}

function applyScheduleTemplate() {
    const template = document.getElementById('scheduleTemplate').value;
    const templates = {
        CLASS: { title: '정규 수업', status: 'NONE', duration: 1 },
        EXAM: { title: '시험', status: 'IMPORTANT', duration: 1 },
        MAKEUP: { title: '보강', status: 'PENDING', duration: 1 },
        QA: { title: '질답', status: 'NONE', duration: 1 },
        HOLIDAY: { title: '휴강·휴무', status: 'IMPORTANT', duration: 1 }
    };
    const selected = templates[template];
    if (!selected) return;
    document.getElementById('schedTitle').value = selected.title;
    document.getElementById('schedStatus').value = selected.status;
    setScheduleDuration('add', selected.duration);
    document.getElementById('schedTitle').focus();
}

function toggleRepeatOptions() {
    const checked = document.getElementById('schedRepeatCheck').checked;
    document.getElementById('repeatCountWrapper').style.display = checked ? 'block' : 'none';
}

function parseDateList(value) {
    const values = [...new Set(String(value || '').split(',').map(item => item.trim()).filter(Boolean))];
    const invalid = values.find(item => !isValidDateString(item));
    if (invalid) throw new Error(`날짜 '${invalid}'의 형식이 올바르지 않습니다.`);
    return values;
}

function buildRepeatDates(baseDate, repeatType, count, weekdays = []) {
    if (repeatType === 'MONTHLY') {
        return Array.from({ length: count }, (_item, index) => addMonths(baseDate, index));
    }
    const baseWeekday = new Date(`${baseDate}T00:00:00Z`).getUTCDay();
    const selectedWeekdays = weekdays.length ? weekdays : [baseWeekday];
    const interval = repeatType === 'BIWEEKLY' ? 14 : 7;
    const dates = [];
    selectedWeekdays.forEach(weekday => {
        const firstOffset = (weekday - baseWeekday + 7) % 7;
        for (let index = 0; index < count; index += 1) dates.push(addDays(baseDate, firstOffset + index * interval));
    });
    return [...new Set(dates)].sort();
}

function confirmScheduleConflicts(candidates, excludedIds = new Set()) {
    const conflicts = [];
    candidates.forEach((candidate, index) => {
        conflicts.push(...findScheduleConflicts(candidate, excludedIds, candidates.slice(0, index)));
    });
    if (!conflicts.length) return true;
    const names = [...new Set(conflicts.map(item => item.title))].slice(0, 5).join(', ');
    return confirm(`기존 일정과 겹치거나 중복될 가능성이 ${conflicts.length}건 있습니다.\n${names}\n\n그래도 저장하시겠습니까?`);
}

function openScheduleModal(dateString = '') {
    document.getElementById('scheduleTemplate').value = 'CUSTOM';
    document.getElementById('schedTitle').value = '';
    document.getElementById('schedDate').value = dateString || new Date().toLocaleDateString('sv-SE');
    document.getElementById('schedTime').value = '';
    document.getElementById('schedMemo').value = '';
    document.getElementById('schedStatus').value = 'NONE';
    setScheduleDuration('add', 1);
    document.getElementById('schedRepeatCheck').checked = false;
    document.getElementById('repeatCountWrapper').style.display = 'none';
    document.getElementById('schedRepeatCount').value = '4';
    document.getElementById('schedRepeatType').value = 'WEEKLY';
    document.getElementById('schedRepeatExclude').value = '';
    document.getElementById('schedExtraDates').value = '';
    document.getElementById('schedTargetSchool').value = 'COMMON';
    const baseWeekday = new Date(`${document.getElementById('schedDate').value}T00:00:00Z`).getUTCDay();
    document.querySelectorAll('#schedRepeatWeekdays input').forEach(input => {
        input.checked = Number(input.value) === baseWeekday;
    });
    updateStudentSelect('add');
    updateDurationPreview('add');
    updateScheduleWarnings('add');
    openModal('scheduleModal');
}

async function addSchedule() {
    const title = cleanText(document.getElementById('schedTitle').value, 120);
    const baseDate = document.getElementById('schedDate').value;
    const timeInput = document.getElementById('schedTime').value.trim();
    const memo = cleanText(document.getElementById('schedMemo').value, 10000);
    const status = document.getElementById('schedStatus').value;
    const isRepeat = document.getElementById('schedRepeatCheck').checked;
    const repeatType = document.getElementById('schedRepeatType').value;
    const repeatCount = isRepeat ? Number.parseInt(document.getElementById('schedRepeatCount').value, 10) : 1;

    if (!title || !baseDate) return alert('제목과 날짜를 입력하세요.');
    if (!Number.isInteger(repeatCount) || repeatCount < 1 || repeatCount > 52) return alert('반복 횟수는 1~52회 사이로 입력하세요.');

    const schedules = [];
    try {
        const durationDays = getDurationDays('add');
        const target = resolveTarget(document.getElementById('schedTargetSchool').value, document.getElementById('schedTargetStudent').value);
        const excludedDates = new Set(parseDateList(document.getElementById('schedRepeatExclude').value));
        const extraDates = parseDateList(document.getElementById('schedExtraDates').value);
        const weekdays = [...document.querySelectorAll('#schedRepeatWeekdays input:checked')].map(input => Number(input.value));
        const repeatDates = isRepeat ? buildRepeatDates(baseDate, repeatType, repeatCount, weekdays) : [baseDate];
        const dates = [...new Set([...repeatDates, ...extraDates])].filter(date => !excludedDates.has(date)).sort();
        if (!dates.length) throw new Error('제외 날짜를 적용한 뒤 등록할 일정이 없습니다.');
        const seriesId = dates.length > 1 ? generateId() : null;
        const now = new Date().toISOString();
        for (let index = 0; index < dates.length; index += 1) {
            const date = dates[index];
            const { start, end } = parseTimeInput(date, timeInput, durationDays);
            schedules.push({
                id: generateId(), title, start, end, durationDays, ...target, memo, status,
                seriesId, occurrenceIndex: index, repeatType: isRepeat ? repeatType : null,
                createdAt: now, updatedAt: now
            });
        }
    } catch (error) {
        return alert(error.message);
    }

    if (!confirmScheduleConflicts(schedules)) return;

    const success = await executeDBUpdate(draft => draft.schedules.push(...schedules), {
        summary: `일정 ${schedules.length}개 등록: ${title}`
    });
    if (!success) return;
    showToast(schedules.length > 1 ? `${schedules.length}개 반복·복수 일정이 등록되었습니다.` : '일정이 등록되었습니다.', 'success');
    closeModal('scheduleModal');
}

function openScheduleEditor(scheduleId) {
    const schedule = db.schedules.find(item => item.id === scheduleId);
    if (!schedule) return;
    document.getElementById('editId').value = schedule.id;
    document.getElementById('editTitle').value = schedule.title;
    document.getElementById('editMemo').value = schedule.memo || '';
    document.getElementById('editStatus').value = schedule.status || 'NONE';
    document.getElementById('editDate').value = schedule.start.split('T')[0];
    setScheduleDuration('edit', schedule.durationDays || 1);
    document.getElementById('editMetadata').textContent = `등록 ${formatDateTime(schedule.createdAt)} · 최근 수정 ${formatDateTime(schedule.updatedAt)}`;
    const seriesCount = schedule.seriesId ? db.schedules.filter(item => item.seriesId === schedule.seriesId).length : 0;
    document.getElementById('editSeriesOptions').style.display = seriesCount > 1 ? 'block' : 'none';
    document.getElementById('editSeriesScope').value = 'ONE';

    let time = '';
    if (schedule.start.includes('T')) {
        time = schedule.start.split('T')[1].slice(0, 5);
        if (schedule.end?.includes('T')) time += `-${schedule.end.split('T')[1].slice(0, 5)}`;
    }
    document.getElementById('editTime').value = time;

    if (schedule.type === 'COMMON') {
        document.getElementById('editTargetSchool').value = 'COMMON';
        updateStudentSelect('edit');
    } else if (schedule.type === 'SCHOOL' && db.schools.some(item => item.id === schedule.targetId)) {
        document.getElementById('editTargetSchool').value = schedule.targetId;
        updateStudentSelect('edit');
        document.getElementById('editTargetStudent').value = 'ALL';
    } else {
        const student = db.students.find(item => item.id === schedule.targetId);
        document.getElementById('editTargetSchool').value = student?.schoolIds?.[0] || 'COMMON';
        updateStudentSelect('edit');
        if (student) document.getElementById('editTargetStudent').value = student.id;
    }
    updateDurationPreview('edit');
    updateScheduleWarnings('edit');
    openModal('detailModal');
}

function getSeriesTargetIds(schedule, scope) {
    if (!schedule.seriesId || scope === 'ONE') return [schedule.id];
    return db.schedules
        .filter(item => item.seriesId === schedule.seriesId && (scope === 'ALL' || item.occurrenceIndex >= schedule.occurrenceIndex))
        .map(item => item.id);
}

async function updateSchedule() {
    const id = document.getElementById('editId').value;
    const title = cleanText(document.getElementById('editTitle').value, 120);
    const date = document.getElementById('editDate').value;
    const memo = cleanText(document.getElementById('editMemo').value, 10000);
    const status = document.getElementById('editStatus').value;
    if (!title || !date) return alert('제목과 날짜를 입력하세요.');

    let values;
    let targetIds;
    let candidates;
    try {
        const durationDays = getDurationDays('edit');
        values = {
            ...parseTimeInput(date, document.getElementById('editTime').value.trim(), durationDays),
            durationDays,
            ...resolveTarget(document.getElementById('editTargetSchool').value, document.getElementById('editTargetStudent').value)
        };
        const original = db.schedules.find(item => item.id === id);
        if (!original) throw new Error('수정할 일정을 찾을 수 없습니다.');
        const scope = document.getElementById('editSeriesScope').value;
        targetIds = getSeriesTargetIds(original, scope);
        const shiftDays = daysBetween(original.start.split('T')[0], date) || 0;
        candidates = targetIds.map(targetId => {
            const current = db.schedules.find(item => item.id === targetId);
            const shiftedDate = targetId === id ? date : addDays(current.start.split('T')[0], shiftDays);
            return {
                ...current,
                title, memo, status, durationDays,
                ...parseTimeInput(shiftedDate, document.getElementById('editTime').value.trim(), durationDays),
                type: values.type,
                targetId: values.targetId,
                updatedAt: new Date().toISOString()
            };
        });
    } catch (error) {
        return alert(error.message);
    }

    if (!confirmScheduleConflicts(candidates, new Set(targetIds))) return;

    const success = await executeDBUpdate(draft => {
        candidates.forEach(candidate => {
            const schedule = draft.schedules.find(item => item.id === candidate.id);
            if (!schedule) throw new Error('반복 일정 중 일부가 다른 기기에서 이미 삭제되었습니다.');
            Object.assign(schedule, candidate);
        });
    }, { summary: `일정 ${candidates.length}개 수정: ${title}` });
    if (!success) return;
    showToast('일정이 수정되었습니다.', 'success');
    closeModal('detailModal');
}

async function deleteSchedule() {
    const id = document.getElementById('editId').value;
    const schedule = db.schedules.find(item => item.id === id);
    if (!schedule) return;
    const scope = document.getElementById('editSeriesScope').value;
    const targetIds = getSeriesTargetIds(schedule, scope);
    if (!confirm(`일정 ${targetIds.length}개를 삭제하시겠습니까? 삭제 후 30일 동안 복원할 수 있습니다.`)) return;
    const trashEntry = createTrashEntry('schedule', targetIds.length > 1 ? `${schedule.title} 외 반복 일정 ${targetIds.length}개` : schedule.title, {
        schedules: db.schedules.filter(item => targetIds.includes(item.id))
    });
    const success = await executeDBUpdate(draft => {
        const idSet = new Set(targetIds);
        const count = draft.schedules.length;
        draft.schedules = draft.schedules.filter(item => !idSet.has(item.id));
        if (count === draft.schedules.length) throw new Error('이 일정은 다른 기기에서 이미 삭제되었습니다.');
        draft.trash.push(trashEntry);
    }, { summary: `일정 ${targetIds.length}개 삭제: ${schedule.title}` });
    if (!success) return;
    showUndoToast('일정을 삭제했습니다.', trashEntry.id);
    closeModal('detailModal');
}

function duplicateSchedule() {
    const schedule = db.schedules.find(item => item.id === document.getElementById('editId').value);
    if (!schedule) return;
    closeModal('detailModal');
    openScheduleModal(schedule.start.split('T')[0]);
    document.getElementById('schedTitle').value = `${schedule.title} 복사`;
    document.getElementById('schedStatus').value = schedule.status;
    document.getElementById('schedMemo').value = schedule.memo || '';
    document.getElementById('schedTime').value = schedule.start.includes('T')
        ? `${schedule.start.split('T')[1].slice(0, 5)}${schedule.end?.includes('T') ? `-${schedule.end.split('T')[1].slice(0, 5)}` : ''}`
        : '';
    setScheduleDuration('add', schedule.durationDays || 1);
    if (schedule.type === 'SCHOOL') {
        document.getElementById('schedTargetSchool').value = schedule.targetId;
        updateStudentSelect('add');
        document.getElementById('schedTargetStudent').value = 'ALL';
    } else if (schedule.type === 'STUDENT') {
        const student = db.students.find(item => item.id === schedule.targetId);
        document.getElementById('schedTargetSchool').value = student?.schoolIds?.[0] || 'COMMON';
        updateStudentSelect('add');
        if (student) document.getElementById('schedTargetStudent').value = student.id;
    }
    updateScheduleWarnings('add');
}

async function copyPreviousWeek() {
    const today = new Date().toLocaleDateString('sv-SE');
    const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
    const currentMonday = addDays(today, weekday === 0 ? -6 : 1 - weekday);
    const targetMonday = prompt('복사할 대상 주의 월요일 날짜를 입력하세요.', currentMonday);
    if (targetMonday === null) return;
    if (!isValidDateString(targetMonday)) return alert('올바른 날짜를 입력하세요.');
    const sourceMonday = addDays(targetMonday, -7);
    const sourceSunday = addDays(sourceMonday, 6);
    const sourceSchedules = db.schedules.filter(schedule => {
        const date = schedule.start.split('T')[0];
        return date >= sourceMonday && date <= sourceSunday;
    });
    if (!sourceSchedules.length) return alert(`${sourceMonday} ~ ${sourceSunday}에 복사할 일정이 없습니다.`);
    if (!confirm(`지난주 일정 ${sourceSchedules.length}개를 ${targetMonday}부터 시작하는 주로 복사하시겠습니까?`)) return;
    const now = new Date().toISOString();
    const copies = sourceSchedules.map(schedule => {
        const shift = daysBetween(sourceMonday, targetMonday);
        const startDate = addDays(schedule.start.split('T')[0], shift);
        const start = schedule.start.includes('T') ? `${startDate}T${schedule.start.split('T')[1]}` : startDate;
        let end = null;
        if (schedule.end) {
            const endDate = addDays(schedule.end.split('T')[0], shift);
            end = schedule.end.includes('T') ? `${endDate}T${schedule.end.split('T')[1]}` : endDate;
        }
        return {
            ...schedule,
            id: generateId(), start, end,
            seriesId: null, occurrenceIndex: 0, repeatType: null,
            createdAt: now, updatedAt: now
        };
    });
    if (!confirmScheduleConflicts(copies)) return;
    const success = await executeDBUpdate(draft => draft.schedules.push(...copies), {
        summary: `지난주 일정 ${copies.length}개 복사`
    });
    if (success) showToast(`일정 ${copies.length}개를 복사했습니다.`, 'success');
}

function openDataManager(tab = 'schools', resetForm = false) {
    switchDataTab(tab);
    if (resetForm) {
        if (tab === 'schools') resetSchoolForm();
        else resetStudentForm();
    }
    openModal('manageDataModal');
    if (window.innerWidth <= 768) toggleSidebar(false);
}

function switchDataTab(tab) {
    const isSchoolTab = tab === 'schools';
    document.getElementById('schoolTabButton').classList.toggle('active', isSchoolTab);
    document.getElementById('studentTabButton').classList.toggle('active', !isSchoolTab);
    document.getElementById('schoolTabPanel').classList.toggle('active', isSchoolTab);
    document.getElementById('studentTabPanel').classList.toggle('active', !isSchoolTab);
}

function resetSchoolForm() {
    document.getElementById('schoolId').value = '';
    document.getElementById('schoolName').value = '';
    document.getElementById('schoolColor').value = '#4F46E5';
    document.getElementById('schoolFormTitle').textContent = '새 그룹 등록';
    document.getElementById('schoolSaveBtn').textContent = '그룹 등록';
    document.getElementById('schoolCancelBtn').style.display = 'none';
}

function editSchool(schoolId) {
    const school = db.schools.find(item => item.id === schoolId);
    if (!school) return showToast('그룹을 찾을 수 없습니다.', 'error');
    switchDataTab('schools');
    document.getElementById('schoolId').value = school.id;
    document.getElementById('schoolName').value = school.name;
    document.getElementById('schoolColor').value = school.color;
    document.getElementById('schoolFormTitle').textContent = '그룹 정보 수정';
    document.getElementById('schoolSaveBtn').textContent = '수정 저장';
    document.getElementById('schoolCancelBtn').style.display = '';
    document.querySelector('#schoolTabPanel .data-form-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
    document.getElementById('schoolName').focus();
}

async function saveSchool() {
    const id = document.getElementById('schoolId').value;
    const name = cleanText(document.getElementById('schoolName').value, 80);
    const color = normalizeColor(document.getElementById('schoolColor').value);
    if (!name) return alert('그룹명을 입력하세요.');
    const newId = id || generateId();
    const now = new Date().toISOString();
    const success = await executeDBUpdate(draft => {
        if (draft.schools.some(item => item.id !== id && item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
            throw new Error('같은 이름의 그룹이 이미 있습니다.');
        }
        if (id) {
            const school = draft.schools.find(item => item.id === id);
            if (!school) throw new Error('이 그룹은 다른 기기에서 이미 삭제되었습니다.');
            Object.assign(school, { name, color, updatedAt: now });
        } else {
            draft.schools.push({ id: newId, name, color, createdAt: now, updatedAt: now });
        }
    }, { summary: `그룹 ${id ? '수정' : '등록'}: ${name}` });
    if (!success) return;
    showToast(`'${name}' 그룹이 ${id ? '수정' : '등록'}되었습니다.`, 'success');
    resetSchoolForm();
}

async function updateSchoolColor(schoolId, color) {
    const success = await executeDBUpdate(draft => {
        const school = draft.schools.find(item => item.id === schoolId);
        if (!school) throw new Error('그룹을 찾을 수 없습니다.');
        school.color = normalizeColor(color);
        school.updatedAt = new Date().toISOString();
    }, { summary: '그룹 색상 변경' });
    if (success) showToast('그룹 색상이 변경되었습니다.', 'success');
}

function getSelectedManageIds(type) {
    const selector = type === 'school' ? '.school-row-select:checked' : '.student-row-select:checked';
    return [...document.querySelectorAll(selector)].map(item => item.value);
}

async function bulkUpdateSchoolColor() {
    const ids = getSelectedManageIds('school');
    if (!ids.length) return alert('색상을 변경할 그룹을 선택하세요.');
    const color = normalizeColor(document.getElementById('bulkSchoolColor').value);
    const idSet = new Set(ids);
    const success = await executeDBUpdate(draft => {
        const now = new Date().toISOString();
        draft.schools.filter(item => idSet.has(item.id)).forEach(item => {
            item.color = color;
            item.updatedAt = now;
        });
    }, { summary: `그룹 ${ids.length}개 색상 일괄 변경` });
    if (success) showToast(`그룹 ${ids.length}개의 색상을 변경했습니다.`, 'success');
}

async function bulkUpdateStudentAffiliation(action) {
    const ids = getSelectedManageIds('student');
    const schoolId = document.getElementById('bulkStudentSchool').value;
    if (!ids.length) return alert('소속을 변경할 학생을 선택하세요.');
    if (!schoolId) return alert('대상 그룹을 선택하세요.');
    const school = db.schools.find(item => item.id === schoolId);
    if (!school) return alert('선택한 그룹을 찾을 수 없습니다.');
    const idSet = new Set(ids);
    const success = await executeDBUpdate(draft => {
        const now = new Date().toISOString();
        draft.students.filter(item => idSet.has(item.id)).forEach(student => {
            if (action === 'add') student.schoolIds = [...new Set([...student.schoolIds, schoolId])];
            else student.schoolIds = student.schoolIds.filter(id => id !== schoolId);
            student.updatedAt = now;
        });
    }, { summary: `학생 ${ids.length}명 소속 ${action === 'add' ? '추가' : '제외'}: ${school.name}` });
    if (success) showToast(`학생 ${ids.length}명의 소속을 변경했습니다.`, 'success');
}

async function mergeDuplicateStudents() {
    const groups = new Map();
    db.students.forEach(student => {
        const key = student.name.replace(/\s+/g, '').toLocaleLowerCase();
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(student);
    });
    const duplicates = [...groups.values()].filter(items => items.length > 1);
    if (!duplicates.length) return alert('이름이 같은 중복 학생이 없습니다.');
    const removedStudents = duplicates.flatMap(items => items.slice(1));
    const removedIds = new Set(removedStudents.map(item => item.id));
    const affectedSchedules = db.schedules.filter(item => item.type === 'STUDENT' && removedIds.has(item.targetId));
    const survivors = duplicates.map(items => items[0]);
    const trashEntry = createTrashEntry('merge', `중복 학생 ${removedStudents.length}명 병합`, {
        students: duplicates.flat(),
        schedules: affectedSchedules
    });
    const detail = duplicates.map(items => `${items[0].name} ${items.length}건`).join(', ');
    if (!confirm(`${detail}\n\n각 이름의 첫 학생을 기준으로 소속과 개인 일정을 합치겠습니까? 휴지통에서 되돌릴 수 있습니다.`)) return;
    const success = await executeDBUpdate(draft => {
        const now = new Date().toISOString();
        duplicates.forEach(items => {
            const survivor = draft.students.find(student => student.id === items[0].id);
            const duplicateIds = new Set(items.slice(1).map(item => item.id));
            survivor.schoolIds = [...new Set(items.flatMap(item => item.schoolIds))];
            survivor.updatedAt = now;
            draft.schedules.forEach(schedule => {
                if (schedule.type === 'STUDENT' && duplicateIds.has(schedule.targetId)) {
                    schedule.targetId = survivor.id;
                    schedule.updatedAt = now;
                }
            });
            draft.students = draft.students.filter(student => !duplicateIds.has(student.id));
        });
        draft.trash.push(trashEntry);
    }, { summary: `중복 학생 ${removedStudents.length}명 병합` });
    if (success) showUndoToast(`중복 학생 ${removedStudents.length}명을 병합했습니다.`, trashEntry.id);
}

function resetStudentForm() {
    document.getElementById('studentId').value = '';
    document.getElementById('studentName').value = '';
    document.getElementById('studentFormTitle').textContent = '새 학생 등록';
    document.getElementById('studentSaveBtn').textContent = '학생 등록';
    document.getElementById('studentCancelBtn').style.display = 'none';
    updateSchoolCheckboxes();
}

function editStudent(studentId) {
    const student = db.students.find(item => item.id === studentId);
    if (!student) return showToast('학생을 찾을 수 없습니다.', 'error');
    switchDataTab('students');
    document.getElementById('studentId').value = student.id;
    document.getElementById('studentName').value = student.name;
    document.getElementById('studentFormTitle').textContent = '학생 정보 수정';
    document.getElementById('studentSaveBtn').textContent = '수정 저장';
    document.getElementById('studentCancelBtn').style.display = '';
    updateSchoolCheckboxes(student.schoolIds);
    document.querySelector('#studentTabPanel .data-form-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
    document.getElementById('studentName').focus();
}

function updateSchoolCheckboxes(selectedIds = []) {
    const selected = new Set(selectedIds);
    document.getElementById('studentSchoolCheckboxes').innerHTML = db.schools.map(school =>
        `<label><input type="checkbox" value="${school.id}" ${selected.has(school.id) ? 'checked' : ''}>` +
        `<span class="color-dot" style="background:${school.color}"></span>${escapeHtml(school.name)}</label>`
    ).join('');
}

async function saveStudent() {
    const id = document.getElementById('studentId').value;
    const name = cleanText(document.getElementById('studentName').value, 80);
    const schoolIds = [...document.querySelectorAll('#studentSchoolCheckboxes input:checked')].map(item => item.value);
    if (!name || schoolIds.length === 0) return alert('이름과 소속 그룹을 하나 이상 선택하세요.');
    const newId = id || generateId();
    const now = new Date().toISOString();
    const success = await executeDBUpdate(draft => {
        const validSchoolIds = schoolIds.filter(schoolId => draft.schools.some(school => school.id === schoolId));
        if (validSchoolIds.length !== schoolIds.length) throw new Error('선택한 그룹 중 일부가 다른 기기에서 삭제되었습니다.');
        if (id) {
            const student = draft.students.find(item => item.id === id);
            if (!student) throw new Error('이 학생은 다른 기기에서 이미 삭제되었습니다.');
            Object.assign(student, { name, schoolIds: validSchoolIds, updatedAt: now });
        } else {
            draft.students.push({ id: newId, name, schoolIds: validSchoolIds, createdAt: now, updatedAt: now });
        }
    }, { summary: `학생 ${id ? '수정' : '등록'}: ${name}` });
    if (!success) return;
    showToast(`'${name}' 학생이 ${id ? '수정' : '등록'}되었습니다.`, 'success');
    resetStudentForm();
}

function toggleSelectAll(type, checked) {
    const selector = type === 'school' ? '.school-row-select' : '.student-row-select';
    document.querySelectorAll(selector).forEach(checkbox => { checkbox.checked = checked; });
    updateSelectionCount(type);
}

function updateSelectionCount(type) {
    const selector = type === 'school' ? '.school-row-select:checked' : '.student-row-select:checked';
    const count = document.querySelectorAll(selector).length;
    document.getElementById(type === 'school' ? 'schoolSelectionCount' : 'studentSelectionCount').textContent = `${count}개 선택`;
    const allCheckboxes = [...document.querySelectorAll(type === 'school' ? '.school-row-select' : '.student-row-select')];
    const selectAll = document.getElementById(type === 'school' ? 'selectAllSchools' : 'selectAllStudents');
    selectAll.checked = allCheckboxes.length > 0 && allCheckboxes.every(item => item.checked);
    selectAll.indeterminate = count > 0 && count < allCheckboxes.length;
}

async function deleteSelectedItems(type) {
    const selector = type === 'school' ? '.school-row-select:checked' : '.student-row-select:checked';
    const ids = [...document.querySelectorAll(selector)].map(item => item.value);
    if (!ids.length) return alert(type === 'school' ? '삭제할 그룹을 선택하세요.' : '삭제할 학생을 선택하세요.');

    const idSet = new Set(ids);
    const targetLabel = type === 'school' ? `그룹 ${ids.length}개` : `학생 ${ids.length}명`;
    const scheduleCount = db.schedules.filter(schedule =>
        (type === 'school' && schedule.type === 'SCHOOL' && idSet.has(schedule.targetId)) ||
        (type === 'student' && schedule.type === 'STUDENT' && idSet.has(schedule.targetId))).length;
    const extraMessage = type === 'school'
        ? `\n학생의 해당 소속 정보도 제거되며, 그룹 일정 ${scheduleCount}개가 함께 삭제됩니다.`
        : `\n학생 개인 일정 ${scheduleCount}개가 함께 삭제됩니다.`;
    if (!confirm(`${targetLabel}를 선택 삭제하시겠습니까?${extraMessage}\n삭제한 데이터는 휴지통에서 30일간 복원할 수 있습니다.`)) return;

    const payload = type === 'school' ? {
        schools: db.schools.filter(item => idSet.has(item.id)),
        students: db.students.filter(item => item.schoolIds.some(id => idSet.has(id))),
        schedules: db.schedules.filter(schedule => schedule.type === 'SCHOOL' && idSet.has(schedule.targetId))
    } : {
        students: db.students.filter(item => idSet.has(item.id)),
        schedules: db.schedules.filter(schedule => schedule.type === 'STUDENT' && idSet.has(schedule.targetId))
    };
    const trashEntry = createTrashEntry(type, targetLabel, payload);

    const success = await executeDBUpdate(draft => {
        if (type === 'school') {
            draft.schools = draft.schools.filter(item => !idSet.has(item.id));
            draft.students.forEach(student => { student.schoolIds = student.schoolIds.filter(id => !idSet.has(id)); });
            draft.schedules = draft.schedules.filter(schedule => !(schedule.type === 'SCHOOL' && idSet.has(schedule.targetId)));
        } else {
            draft.students = draft.students.filter(item => !idSet.has(item.id));
            draft.schedules = draft.schedules.filter(schedule => !(schedule.type === 'STUDENT' && idSet.has(schedule.targetId)));
        }
        draft.trash.push(trashEntry);
    }, { summary: `선택 삭제: ${targetLabel}` });
    if (!success) return;

    if (idSet.has(currentFilter.schoolId) || idSet.has(currentFilter.studentId)) {
        Object.assign(currentFilter, { type: 'ALL', schoolId: null, studentId: null });
    }
    if (type === 'school' && idSet.has(document.getElementById('schoolId').value)) resetSchoolForm();
    if (type === 'student' && idSet.has(document.getElementById('studentId').value)) resetStudentForm();
    showUndoToast(`${targetLabel}를 삭제했습니다.`, trashEntry.id);
}

async function deleteItem(type, id) {
    let label;
    let payload;
    if (type === 'school') {
        const school = db.schools.find(item => item.id === id);
        if (!school) return;
        label = school.name;
        const scheduleCount = db.schedules.filter(item => item.type === 'SCHOOL' && item.targetId === id).length;
        const studentCount = db.students.filter(item => item.schoolIds.includes(id)).length;
        if (!confirm(`'${school.name}' 그룹을 삭제하시겠습니까?\n\n그룹 일정 ${scheduleCount}개는 함께 삭제되고, 학생 ${studentCount}명의 해당 소속 정보가 제거됩니다.\n휴지통에서 30일간 복원할 수 있습니다.`)) return;
        payload = {
            schools: [school],
            students: db.students.filter(item => item.schoolIds.includes(id)),
            schedules: db.schedules.filter(item => item.type === 'SCHOOL' && item.targetId === id)
        };
    } else {
        const student = db.students.find(item => item.id === id);
        if (!student) return;
        label = student.name;
        const scheduleCount = db.schedules.filter(item => item.type === 'STUDENT' && item.targetId === id).length;
        if (!confirm(`'${student.name}' 학생을 삭제하시겠습니까?\n\n학생 개인 일정 ${scheduleCount}개도 함께 삭제됩니다.\n휴지통에서 30일간 복원할 수 있습니다.`)) return;
        payload = {
            students: [student],
            schedules: db.schedules.filter(item => item.type === 'STUDENT' && item.targetId === id)
        };
    }

    const trashEntry = createTrashEntry(type, label, payload);

    const success = await executeDBUpdate(draft => {
        if (type === 'school') {
            if (!draft.schools.some(item => item.id === id)) throw new Error('이 그룹은 다른 기기에서 이미 삭제되었습니다.');
            draft.schools = draft.schools.filter(item => item.id !== id);
            draft.students.forEach(student => { student.schoolIds = student.schoolIds.filter(schoolId => schoolId !== id); });
            draft.schedules = draft.schedules.filter(schedule => !(schedule.type === 'SCHOOL' && schedule.targetId === id));
        } else {
            if (!draft.students.some(item => item.id === id)) throw new Error('이 학생은 다른 기기에서 이미 삭제되었습니다.');
            draft.students = draft.students.filter(item => item.id !== id);
            draft.schedules = draft.schedules.filter(schedule => !(schedule.type === 'STUDENT' && schedule.targetId === id));
        }
        draft.trash.push(trashEntry);
    }, { summary: `${type === 'school' ? '그룹' : '학생'} 삭제: ${label}` });
    if (!success) return;
    if (currentFilter.schoolId === id || currentFilter.studentId === id) {
        Object.assign(currentFilter, { type: 'ALL', schoolId: null, studentId: null });
    }
    if (type === 'school' && document.getElementById('schoolId').value === id) resetSchoolForm();
    if (type === 'student' && document.getElementById('studentId').value === id) resetStudentForm();
    showUndoToast('연결된 데이터를 정리하고 삭제했습니다.', trashEntry.id);
}

function updateManageStudentList() {
    const schoolId = document.getElementById('manageStudentSchoolSelect').value;
    const query = cleanText(document.getElementById('manageStudentSearch').value, 120).toLocaleLowerCase();
    const list = document.getElementById('manageStudentList');
    let students = db.students;
    if (schoolId === 'NO_GROUP') students = students.filter(student => student.schoolIds.length === 0);
    else if (schoolId === 'NO_SCHEDULE') {
        const scheduledIds = new Set(db.schedules.filter(item => item.type === 'STUDENT').map(item => item.targetId));
        students = students.filter(student => !scheduledIds.has(student.id));
    } else if (schoolId !== 'ALL') students = students.filter(student => student.schoolIds.includes(schoolId));
    const schoolNamesById = new Map(db.schools.map(school => [school.id, school.name]));
    if (query) {
        students = students.filter(student => {
            const affiliations = student.schoolIds.map(id => schoolNamesById.get(id) || '').join(' ');
            return `${student.name} ${affiliations}`.toLocaleLowerCase().includes(query);
        });
    }
    if (!students.length) {
        list.innerHTML = '<li class="empty-list">등록된 학생이 없습니다.</li>';
        updateSelectionCount('student');
        return;
    }
    list.innerHTML = students.map(student => {
        const affiliations = student.schoolIds.map(id => schoolNamesById.get(id)).filter(Boolean).join(', ') || '소속 없음';
        return `<li><label class="row-select"><input class="student-row-select" type="checkbox" value="${student.id}" onchange="updateSelectionCount('student')">` +
            `<span><b>${escapeHtml(student.name)}</b><small>${escapeHtml(affiliations)} · 수정 ${escapeHtml(formatDateTime(student.updatedAt))}</small></span></label>` +
            `<span class="manage-actions"><button class="edit-btn" onclick="editStudent('${student.id}')">수정</button>` +
            `<button class="delete-btn" onclick="deleteItem('student', '${student.id}')">삭제</button></span></li>`;
    }).join('');
    updateSelectionCount('student');
}

function renderStudentFilterButtons() {
    const studentContainer = document.getElementById('filter-student-container');
    if (currentFilter.type === 'ALL' || currentFilter.type === 'MULTI_SCHOOL') {
        studentContainer.style.display = 'none';
        studentContainer.replaceChildren();
        return;
    }

    studentContainer.style.display = 'flex';
    const students = db.students.filter(student => student.schoolIds.includes(currentFilter.schoolId));
    studentContainer.innerHTML = students.length
        ? students.map(student => `<button class="filter-pill ${currentFilter.studentId === student.id ? 'active' : ''}" onclick="toggleStudentFilter('${student.id}')">${escapeHtml(student.name)}</button>`).join('')
        : '<span class="empty-filter">소속된 학생이 없습니다.</span>';
}

function updateFilterControls() {
    const filterSchool = document.getElementById('filter-school');
    filterSchool.innerHTML = `<option value="ALL">전체 일정 보기</option>${db.schools.map(school =>
        `<option value="${school.id}">${escapeHtml(school.name)}</option>`).join('')}`;
    filterSchool.value = currentFilter.schoolId || 'ALL';

    const multiSchool = document.getElementById('filterSchoolsMulti');
    multiSchool.innerHTML = db.schools.map(school => `<option value="${school.id}">${escapeHtml(school.name)}</option>`).join('');
    const selectedIds = new Set(currentFilter.schoolIds);
    [...multiSchool.options].forEach(option => { option.selected = selectedIds.has(option.value); });
    document.getElementById('filterSearch').value = currentFilter.query || '';
    document.getElementById('filterStatus').value = currentFilter.status || 'ALL';
    document.getElementById('filterDateFrom').value = currentFilter.dateFrom || '';
    document.getElementById('filterDateTo').value = currentFilter.dateTo || '';
    renderStudentFilterButtons();
}

function updateUI() {
    if (currentFilter.schoolId && !db.schools.some(item => item.id === currentFilter.schoolId)) {
        Object.assign(currentFilter, { type: 'ALL', schoolId: null, studentId: null });
    }
    if (currentFilter.studentId && !db.students.some(item => item.id === currentFilter.studentId)) {
        if (currentFilter.schoolId) Object.assign(currentFilter, { type: 'SCHOOL', studentId: null });
        else Object.assign(currentFilter, { type: 'ALL', schoolId: null, studentId: null });
    }
    currentFilter.schoolIds = currentFilter.schoolIds.filter(id => db.schools.some(item => item.id === id));
    if (currentFilter.type === 'MULTI_SCHOOL' && !currentFilter.schoolIds.length) currentFilter.type = 'ALL';

    const knownSchoolIds = new Set(db.schools.map(item => item.id));
    const knownStudentIds = new Set(db.students.map(item => item.id));
    const missingAffiliations = db.students.reduce((count, student) =>
        count + student.schoolIds.filter(id => !knownSchoolIds.has(id)).length, 0);
    const missingScheduleTargets = db.schedules.filter(schedule =>
        (schedule.type === 'SCHOOL' && !knownSchoolIds.has(schedule.targetId)) ||
        (schedule.type === 'STUDENT' && !knownStudentIds.has(schedule.targetId))).length;
    const integritySummary = document.getElementById('dataIntegritySummary');
    const needsRepair = missingAffiliations + missingScheduleTargets > 0;
    integritySummary.classList.toggle('warning', needsRepair);
    integritySummary.textContent = needsRepair
        ? `정리 필요: 삭제된 그룹 소속 ${missingAffiliations}건 · 대상이 없는 일정 ${missingScheduleTargets}건. 해당 학생/일정을 수정하면 정리할 수 있습니다.`
        : '데이터 연결 상태가 정상입니다.';

    const editingStudent = db.students.find(item => item.id === document.getElementById('studentId').value);
    const selectedSchoolIds = editingStudent?.schoolIds ||
        [...document.querySelectorAll('#studentSchoolCheckboxes input:checked')].map(item => item.value);
    updateSchoolCheckboxes(selectedSchoolIds);
    const schoolOptions = `<option value="COMMON">전체 공통 적용</option>${db.schools.map(school =>
        `<option value="${school.id}">${escapeHtml(school.name)}</option>`).join('')}`;
    const addTargetSchool = document.getElementById('schedTargetSchool');
    const editTargetSchool = document.getElementById('editTargetSchool');
    const addValue = addTargetSchool.value;
    const editValue = editTargetSchool.value;
    addTargetSchool.innerHTML = schoolOptions;
    editTargetSchool.innerHTML = schoolOptions;
    if ([...addTargetSchool.options].some(option => option.value === addValue)) addTargetSchool.value = addValue;
    if ([...editTargetSchool.options].some(option => option.value === editValue)) editTargetSchool.value = editValue;
    updateStudentSelect('add');

    updateFilterControls();

    const schoolList = document.getElementById('manageSchoolList');
    schoolList.innerHTML = db.schools.length ? db.schools.map(school =>
        `<li><label class="row-select"><input class="school-row-select" type="checkbox" value="${school.id}" onchange="updateSelectionCount('school')">` +
        `<span><span class="school-list-name"><span class="color-dot" style="background:${school.color}"></span>${escapeHtml(school.name)}</span>` +
        `<small>수정 ${escapeHtml(formatDateTime(school.updatedAt))}</small></span></label>` +
        `<span class="manage-actions"><button class="edit-btn" onclick="editSchool('${school.id}')">수정</button>` +
        `<button class="delete-btn" onclick="deleteItem('school', '${school.id}')">삭제</button></span></li>`
    ).join('') : '<li class="empty-list">등록된 그룹이 없습니다.</li>';
    updateSelectionCount('school');

    const manageSchoolSelect = document.getElementById('manageStudentSchoolSelect');
    const manageValue = manageSchoolSelect.value;
    manageSchoolSelect.innerHTML = `<option value="ALL">전체 학생 보기</option>` +
        `<option value="NO_GROUP">소속 없는 학생</option><option value="NO_SCHEDULE">개인 일정 없는 학생</option>${db.schools.map(school =>
        `<option value="${school.id}">${escapeHtml(school.name)}</option>`).join('')}`;
    if ([...manageSchoolSelect.options].some(option => option.value === manageValue)) manageSchoolSelect.value = manageValue;
    const bulkStudentSchool = document.getElementById('bulkStudentSchool');
    const bulkValue = bulkStudentSchool.value;
    bulkStudentSchool.innerHTML = `<option value="">대상 그룹 선택</option>${db.schools.map(school =>
        `<option value="${school.id}">${escapeHtml(school.name)}</option>`).join('')}`;
    if ([...bulkStudentSchool.options].some(option => option.value === bulkValue)) bulkStudentSchool.value = bulkValue;
    updateManageStudentList();
    renderSafetyCenter();
}

function validateImportShape(parsed) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('최상위 데이터는 JSON 객체여야 합니다.');
    for (const key of ['schools', 'students', 'schedules', 'memos', 'trash']) {
        if (parsed[key] !== undefined && !Array.isArray(parsed[key])) throw new Error(`'${key}' 항목은 배열이어야 합니다.`);
    }

    const keys = ['schools', 'students', 'schedules', 'memos'];
    const labels = ['그룹', '학생', '일정', '이전 메모'];
    const rawCounts = keys.map(key => asArray(parsed[key]).length);
    // 기존 백업에 삭제된 그룹/학생을 가리키는 기록이 있어도 자동 소실시키지 않는다.
    // 화면에서 '소속 없음'으로 노출해 사용자가 수정할 수 있게 보존한다.
    const normalized = normalizeDatabase(parsed);
    const cleanCounts = keys.map(key => normalized[key].length);
    const invalidIndex = rawCounts.findIndex((count, index) => count !== cleanCounts[index]);
    if (invalidIndex >= 0) throw new Error(`${labels[invalidIndex]} 데이터에 필수값 오류 또는 끊어진 참조가 있습니다.`);
    const normalizedStudents = new Map(normalized.students.map(student => [student.id, student]));
    const hasLostAffiliation = asArray(parsed.students).some(student => {
        const originalIds = [...new Set(asArray(student.schoolIds).filter(isValidId))];
        return originalIds.length !== (normalizedStudents.get(student.id)?.schoolIds.length ?? -1);
    });
    if (hasLostAffiliation) throw new Error('학생의 그룹 참조를 찾을 수 없습니다.');

    return normalized;
}

function resetImportPreview() {
    pendingImport = null;
    const preview = document.getElementById('importPreview');
    if (!preview) return;
    preview.className = 'import-preview';
    preview.textContent = 'JSON을 입력한 뒤 미리보기를 실행하세요.';
    document.getElementById('applyImportButton').disabled = true;
}

function getImportDiff(imported, mode) {
    const labels = { schools: '그룹', students: '학생', schedules: '일정', memos: '이전 메모', trash: '휴지통' };
    const rows = [];
    let totalDeletes = 0;
    for (const key of Object.keys(createEmptyDatabase())) {
        const currentMap = new Map(db[key].map(item => [item.id, item]));
        const importedMap = new Map(imported[key].map(item => [item.id, item]));
        const added = imported[key].filter(item => !currentMap.has(item.id)).length;
        const changed = imported[key].filter(item => currentMap.has(item.id) && JSON.stringify(currentMap.get(item.id)) !== JSON.stringify(item)).length;
        const deleted = mode === 'overwrite' ? db[key].filter(item => !importedMap.has(item.id)).length : 0;
        totalDeletes += deleted;
        rows.push({ key, label: labels[key], added, changed, deleted });
    }
    return { rows, totalDeletes };
}

function previewImportData() {
    try {
        const mode = document.getElementById('importMode').value;
        const parsed = JSON.parse(document.getElementById('jsonInputData').value);
        const imported = validateImportShape(parsed);
        const diff = getImportDiff(imported, mode);
        pendingImport = { mode, imported, diff };
        const preview = document.getElementById('importPreview');
        preview.className = 'import-preview ready';
        preview.textContent = diff.rows.map(row =>
            `${row.label}: 추가 ${row.added} · 수정 ${row.changed}${mode === 'overwrite' ? ` · 삭제 ${row.deleted}` : ''}`
        ).join('\n') + '\n\n검증 완료 · 적용 전 현재 데이터가 자동 백업됩니다.';
        document.getElementById('applyImportButton').disabled = false;
    } catch (error) {
        pendingImport = null;
        const preview = document.getElementById('importPreview');
        preview.className = 'import-preview error';
        preview.textContent = `검증 오류: ${error.message}`;
        document.getElementById('applyImportButton').disabled = true;
    }
}

async function applyImportPreview() {
    if (!pendingImport) return alert('먼저 변경 내용 미리보기를 실행하세요.');
    const { mode, imported, diff } = pendingImport;
    if (mode === 'overwrite' && !confirm(`현재 데이터를 교체합니다. 삭제 예정 ${diff.totalDeletes}건입니다. 적용 직전 상태는 변경 이력에 백업됩니다. 계속하시겠습니까?`)) return;
    const success = await executeDBUpdate(draft => {
        if (mode === 'overwrite') {
            for (const key of Object.keys(createEmptyDatabase())) draft[key] = cloneDatabase(imported[key]);
            return;
        }
        for (const key of Object.keys(createEmptyDatabase())) draft[key] = upsertRecords(draft[key], imported[key]);
    }, { summary: `JSON 데이터 ${mode === 'overwrite' ? '전체 교체' : '병합'}` });
    if (!success) return;
    closeModal('jsonImportModal');
    document.getElementById('jsonInputData').value = '';
    resetImportPreview();
    showToast('미리보기와 일치하는 데이터를 저장했습니다.', 'success');
}

async function exportData() {
    try {
        await navigator.clipboard.writeText(JSON.stringify(db, null, 2));
        showToast('클립보드에 데이터가 복사되었습니다.', 'success');
    } catch (error) {
        console.error(error);
        showToast('클립보드 복사에 실패했습니다. 파일 저장을 이용해주세요.', 'error');
    }
}

function downloadJSONFile() {
    const blob = new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `schedule_data_${new Date().toLocaleDateString('sv-SE')}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
}

function uploadJSONFile(event) {
    const file = event.target.files[0];
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) {
        alert('가져오기 파일은 5MB 이하여야 합니다.');
        event.target.value = '';
        return;
    }

    const reader = new FileReader();
    reader.onload = loadEvent => {
        document.getElementById('jsonInputData').value = loadEvent.target.result;
        openModal('jsonImportModal');
        resetImportPreview();
        previewImportData();
        event.target.value = '';
    };
    reader.onerror = () => {
        alert('파일을 읽지 못했습니다.');
        event.target.value = '';
    };
    reader.readAsText(file);
}

let calendarRenderTimer = null;
function renderCalendar(delay = 0) {
    if (!calendar) return;
    window.clearTimeout(calendarRenderTimer);
    calendarRenderTimer = window.setTimeout(() => {
        calendarRenderTimer = null;
        calendar.refetchEvents();
    }, delay);
}

function openModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    if (window.innerWidth <= 768) toggleSidebar(false);
    const openModalCount = [...document.querySelectorAll('.modal-overlay')]
        .filter(item => item !== modal && item.style.display === 'flex').length;
    modal.style.zIndex = String(100 + openModalCount * 10);
    modal.style.display = 'flex';
}

function closeModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    modal.style.display = 'none';
    modal.style.removeProperty('z-index');
}

document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    const visibleModals = [...document.querySelectorAll('.modal-overlay')].filter(item => item.style.display === 'flex');
    if (visibleModals.length) closeModal(visibleModals.at(-1).id);
});
