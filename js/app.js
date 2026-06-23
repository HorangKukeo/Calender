// ==========================================
// 🌐 Firebase Realtime DB 설정
// ==========================================
const DB_URL = "https://horangcalender-default-rtdb.firebaseio.com/data.json";
const ADMIN_KEY = "horangsik2";

let db = { schools: [], students: [], schedules: [] };
let currentFilter = { type: 'ALL', schoolId: null, studentId: null };
let calendar;

// 🎨 토스트(Toast) 팝업 함수
function showToast(message) {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    container.appendChild(toast);
    
    setTimeout(() => toast.classList.add('show'), 10);
    
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// 📱 모바일 사이드바 토글
function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    if (sidebar.classList.contains('active')) {
        sidebar.classList.remove('active');
        overlay.style.display = 'none';
    } else {
        sidebar.classList.add('active');
        overlay.style.display = 'block';
    }
}

// Firebase 데이터 로드
async function fetchLatestData() {
    try {
        const res = await fetch(DB_URL);
        const data = await res.json();
        if (data) {
            db.schools = data.schools || [];
            db.students = data.students || [];
            db.schedules = data.schedules || [];
        }
        return true;
    } catch (error) {
        console.error("Firebase 로드 실패:", error);
        return false;
    }
}

// Firebase 데이터 저장
async function saveToFirebase() {
    const payload = {
        schools: db.schools || [],
        students: db.students || [],
        schedules: db.schedules || [],
        adminKey: ADMIN_KEY 
    };

    try {
        const res = await fetch(DB_URL, {
            method: 'PUT', 
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!res.ok) throw new Error("저장 권한 없음");
    } catch (error) {
        console.error("Firebase 저장 실패:", error);
        throw error;
    }
}

// DB 업데이트 실행기
async function executeDBUpdate(action) {
    try {
        await fetchLatestData();
        action();
        updateUI();
        renderCalendar();
        await saveToFirebase();
    } catch (e) {
        console.error(e);
        showToast("데이터 저장 중 오류가 발생했습니다.");
    }
}

document.addEventListener('DOMContentLoaded', async function() {
    const calendarEl = document.getElementById('calendar');
    calendar = new FullCalendar.Calendar(calendarEl, {
        initialView: 'dayGridMonth',
        locale: 'ko',
        headerToolbar: { left: 'prev,next today', center: 'title', right: 'dayGridMonth,timeGridWeek,timeGridDay' },
        buttonText: { today: '오늘', month: '월별', week: '주간', day: '일별' },
        editable: true,
        eventDurationEditable: true,
        
        events: function(fetchInfo, successCallback, failureCallback) {
            let filteredSchedules = db.schedules || [];

            if (currentFilter.type === 'SCHOOL') {
                const targetId = currentFilter.schoolId;
                const schoolStudents = (db.students || []).filter(st => st.schoolIds && st.schoolIds.includes(targetId)).map(st => st.id);
                filteredSchedules = filteredSchedules.filter(sc => 
                    sc.type === 'COMMON' || 
                    (sc.type === 'SCHOOL' && sc.targetId === targetId) ||
                    (sc.type === 'STUDENT' && schoolStudents.includes(sc.targetId))
                );
            } else if (currentFilter.type === 'STUDENT') {
                const student = (db.students || []).find(st => st.id === currentFilter.studentId);
                const stuSchools = student ? student.schoolIds || [] : [];
                filteredSchedules = filteredSchedules.filter(sc => 
                    sc.type === 'COMMON' || 
                    (sc.type === 'STUDENT' && sc.targetId === currentFilter.studentId) ||
                    (sc.type === 'SCHOOL' && stuSchools.includes(sc.targetId))
                );
            }

            const events = filteredSchedules.map(sc => {
                let bgColor = '#4F46E5'; 
                if (sc.type === 'SCHOOL') {
                    const school = (db.schools || []).find(s => s.id === sc.targetId);
                    if (school && school.color) bgColor = school.color;
                    else bgColor = '#10B981'; 
                } else if (sc.type === 'STUDENT') {
                    const st = (db.students || []).find(s => s.id === sc.targetId);
                    if (st && st.schoolIds && st.schoolIds.length > 0) {
                        const parentSchool = (db.schools || []).find(s => s.id === st.schoolIds[0]);
                        if (parentSchool && parentSchool.color) bgColor = parentSchool.color;
                        else bgColor = '#F59E0B';
                    } else {
                        bgColor = '#F59E0B';
                    }
                }

                // ✨ 일정 상태(status)에 따른 제목 및 클래스명 처리
                let displayTitle = sc.title;
                let classNames = [];
                let status = sc.status || 'NONE';

                if (status === 'COMPLETED') {
                    displayTitle = '✅ ' + displayTitle;
                    classNames.push('event-completed');
                } else if (status === 'IMPORTANT') {
                    displayTitle = '⭐ ' + displayTitle;
                    classNames.push('event-important');
                } else if (status === 'PENDING') {
                    displayTitle = '⏳ ' + displayTitle;
                    classNames.push('event-pending');
                }

                return {
                    id: sc.id, 
                    title: displayTitle, 
                    start: sc.start, 
                    end: sc.end, 
                    backgroundColor: bgColor, 
                    borderColor: bgColor,
                    classNames: classNames
                };
            });
            successCallback(events);
        },
        
        dateClick: function(info) {
            document.getElementById('schedDate').value = info.dateStr;
            document.getElementById('schedTime').value = '';
            document.getElementById('schedMemo').value = '';
            document.getElementById('schedStatus').value = 'NONE'; // 기본 상태
            
            document.getElementById('schedRepeatCheck').checked = false;
            document.getElementById('repeatCountWrapper').style.display = 'none';
            document.getElementById('schedRepeatCount').value = 4;

            document.getElementById('schedTargetSchool').value = 'COMMON';
            updateStudentSelect('add');
            openModal('scheduleModal');
        },
        
        eventClick: function(info) {
            const sched = db.schedules.find(s => s.id === info.event.id);
            if(!sched) return;
            
            document.getElementById('editId').value = sched.id;
            document.getElementById('editTitle').value = sched.title;
            document.getElementById('editMemo').value = sched.memo || '';
            document.getElementById('editStatus').value = sched.status || 'NONE';
            
            document.getElementById('editDate').value = sched.start.split('T')[0];
            let timeStr = '';
            if (sched.start.includes('T')) {
                timeStr = sched.start.split('T')[1].substring(0, 5);
                if (sched.end && sched.end.includes('T')) {
                    timeStr += `-${sched.end.split('T')[1].substring(0, 5)}`;
                }
            }
            document.getElementById('editTime').value = timeStr;

            if (sched.type === 'COMMON') {
                document.getElementById('editTargetSchool').value = 'COMMON';
                updateStudentSelect('edit');
            } else if (sched.type === 'SCHOOL') {
                document.getElementById('editTargetSchool').value = sched.targetId;
                updateStudentSelect('edit');
                document.getElementById('editTargetStudent').value = 'ALL';
            } else if (sched.type === 'STUDENT') {
                const st = db.students.find(s => s.id === sched.targetId);
                if (st && st.schoolIds && st.schoolIds.length > 0) {
                    document.getElementById('editTargetSchool').value = st.schoolIds[0];
                    updateStudentSelect('edit');
                    document.getElementById('editTargetStudent').value = st.id;
                } else {
                    document.getElementById('editTargetSchool').value = 'COMMON';
                    updateStudentSelect('edit');
                }
            }
            openModal('detailModal');
        },

        eventDrop: async function(info) {
            const schedId = info.event.id;
            const getLocalIso = (dateObj) => {
                if(!dateObj) return null;
                const offset = dateObj.getTimezoneOffset() * 60000;
                return (new Date(dateObj - offset)).toISOString().slice(0, -1);
            };
            
            const startStr = getLocalIso(info.event.start);
            const endStr = getLocalIso(info.event.end);
            
            await executeDBUpdate(() => {
                const sched = db.schedules.find(s => s.id === schedId);
                if(sched) {
                    sched.start = info.event.allDay ? startStr.split('T')[0] : startStr;
                    sched.end = endStr ? (info.event.allDay ? endStr.split('T')[0] : endStr) : null;
                }
            });
            showToast("일정이 이동되었습니다.");
        },

        eventResize: async function(info) {
            const schedId = info.event.id;
            const getLocalIso = (dateObj) => {
                if(!dateObj) return null;
                const offset = dateObj.getTimezoneOffset() * 60000;
                return (new Date(dateObj - offset)).toISOString().slice(0, -1);
            };
            
            const startStr = getLocalIso(info.event.start);
            const endStr = getLocalIso(info.event.end);

            await executeDBUpdate(() => {
                const sched = db.schedules.find(s => s.id === schedId);
                if(sched) {
                    sched.start = info.event.allDay ? startStr.split('T')[0] : startStr;
                    sched.end = endStr ? (info.event.allDay ? endStr.split('T')[0] : endStr) : null;
                }
            });
            showToast("일정 시간이 변경되었습니다.");
        }
    });
    calendar.render();
    
    await fetchLatestData();
    updateUI();
    renderCalendar();
});

const generateId = () => Math.random().toString(36).substr(2, 9);

function handleSchoolFilterChange() {
    const val = document.getElementById('filter-school').value;
    if(val === 'ALL') {
        currentFilter = { type: 'ALL', schoolId: null, studentId: null };
    } else {
        currentFilter = { type: 'SCHOOL', schoolId: val, studentId: null };
    }
    updateUI(); 
    renderCalendar();
}

function toggleStudentFilter(studentId) {
    if(currentFilter.studentId === studentId) {
        currentFilter.studentId = null;
        currentFilter.type = 'SCHOOL';
    } else {
        currentFilter.studentId = studentId;
        currentFilter.type = 'STUDENT';
    }
    updateUI();
    renderCalendar();
}

function updateStudentSelect(mode) {
    const schoolSel = document.getElementById(mode === 'add' ? 'schedTargetSchool' : 'editTargetSchool');
    const studentSel = document.getElementById(mode === 'add' ? 'schedTargetStudent' : 'editTargetStudent');
    const schoolId = schoolSel.value;

    if (schoolId === 'COMMON') {
        studentSel.innerHTML = '<option value="ALL">전체 공통 적용</option>';
        studentSel.disabled = true;
    } else {
        studentSel.disabled = false;
        const studentsInSchool = (db.students || []).filter(st => st.schoolIds && st.schoolIds.includes(schoolId));
        let html = '<option value="ALL">해당 그룹 전체 대상</option>';
        studentsInSchool.forEach(st => {
            html += `<option value="${st.id}">[학생] ${st.name}</option>`;
        });
        studentSel.innerHTML = html;
    }
}

function parseTimeInput(dateStr, timeInput) {
    let start = dateStr, end = null;
    if(timeInput) {
        const times = timeInput.split('-');
        if(times.length >= 1 && times[0].trim() !== '') start = `${dateStr}T${times[0].trim()}:00`;
        if(times.length >= 2 && times[1].trim() !== '') end = `${dateStr}T${times[1].trim()}:00`;
    }
    return { start, end };
}

function resolveTarget(schoolVal, studentVal) {
    if (schoolVal === 'COMMON') return { type: 'COMMON', targetId: null };
    if (studentVal === 'ALL') return { type: 'SCHOOL', targetId: schoolVal };
    return { type: 'STUDENT', targetId: studentVal };
}

// 일정 등록
async function addSchedule() {
    const title = document.getElementById('schedTitle').value;
    const baseDateStr = document.getElementById('schedDate').value;
    const timeInput = document.getElementById('schedTime').value.trim();
    const memo = document.getElementById('schedMemo').value;
    const status = document.getElementById('schedStatus').value; // 상태 가져오기
    
    const isRepeat = document.getElementById('schedRepeatCheck').checked;
    const repeatCount = isRepeat ? parseInt(document.getElementById('schedRepeatCount').value) || 1 : 1;
    
    if (!title || !baseDateStr) return alert('제목과 날짜를 입력하세요.');
    
    const { type, targetId } = resolveTarget(document.getElementById('schedTargetSchool').value, document.getElementById('schedTargetStudent').value);

    await executeDBUpdate(() => {
        let currentDate = new Date(baseDateStr);
        for(let i=0; i < repeatCount; i++) {
            const offset = currentDate.getTimezoneOffset() * 60000;
            const loopDateStr = (new Date(currentDate - offset)).toISOString().split('T')[0];
            
            const { start, end } = parseTimeInput(loopDateStr, timeInput);
            
            db.schedules.push({ 
                id: generateId(), title, start, end, type, targetId, memo, status 
            });
            
            currentDate.setDate(currentDate.getDate() + 7);
        }
    });
    
    showToast(isRepeat ? `${repeatCount}주 반복 일정이 등록되었습니다.` : "일정이 등록되었습니다.");
    closeModal('scheduleModal');
}

// 일정 수정
async function updateSchedule() {
    const id = document.getElementById('editId').value;
    const title = document.getElementById('editTitle').value;
    const date = document.getElementById('editDate').value;
    const timeInput = document.getElementById('editTime').value.trim();
    const memo = document.getElementById('editMemo').value;
    const status = document.getElementById('editStatus').value; // 상태 가져오기
    
    if (!title || !date) return alert('제목과 날짜를 입력하세요.');

    const { start, end } = parseTimeInput(date, timeInput);
    const { type, targetId } = resolveTarget(document.getElementById('editTargetSchool').value, document.getElementById('editTargetStudent').value);

    await executeDBUpdate(() => {
        const sched = db.schedules.find(s => s.id === id);
        if(sched) {
            sched.title = title; sched.start = start; sched.end = end;
            sched.type = type; sched.targetId = targetId; sched.memo = memo; sched.status = status;
        }
    });
    showToast('일정이 수정되었습니다.');
    closeModal('detailModal');
}

async function deleteSchedule() {
    if(!confirm("이 일정을 정말 삭제하시겠습니까?")) return;
    const id = document.getElementById('editId').value;
    await executeDBUpdate(() => {
        db.schedules = db.schedules.filter(s => s.id !== id);
    });
    showToast('일정이 삭제되었습니다.');
    closeModal('detailModal');
}

async function addSchool() {
    const name = document.getElementById('schoolName').value;
    const color = document.getElementById('schoolColor').value; 
    if (!name) return;
    
    await executeDBUpdate(() => db.schools.push({ id: generateId(), name: name, color: color }));
    document.getElementById('schoolName').value = '';
    showToast(`'${name}' 그룹이 등록되었습니다.`);
    closeModal('schoolModal');
}

async function updateSchoolColor(schoolId, newColor) {
    await executeDBUpdate(() => {
        const school = db.schools.find(s => s.id === schoolId);
        if (school) {
            school.color = newColor;
        }
    });
    showToast("그룹 색상이 변경되었습니다.");
}

async function addStudent() {
    const name = document.getElementById('studentName').value;
    const checkboxes = document.querySelectorAll('#studentSchoolCheckboxes input:checked');
    const selectedIds = Array.from(checkboxes).map(cb => cb.value);
    
    if (!name || selectedIds.length === 0) return alert('이름과 소속 그룹을 하나 이상 선택하세요.');
    await executeDBUpdate(() => db.students.push({ id: generateId(), name: name, schoolIds: selectedIds }));
    document.getElementById('studentName').value = '';
    showToast(`'${name}' 학생이 등록되었습니다.`);
    closeModal('studentModal');
}

async function deleteItem(type, id) {
    if(!confirm("정말 삭제하시겠습니까? 관련 일정도 연결을 잃을 수 있습니다.")) return;
    await executeDBUpdate(() => {
        if(type === 'school') db.schools = db.schools.filter(s => s.id !== id);
        if(type === 'student') db.students = db.students.filter(s => s.id !== id);
    });
    showToast("삭제 완료되었습니다.");
}

function updateManageStudentList() {
    const schoolId = document.getElementById('manageStudentSchoolSelect').value;
    const studentListEl = document.getElementById('manageStudentList');
    
    let filteredStudents = db.students || [];
    if (schoolId !== 'ALL') {
        filteredStudents = filteredStudents.filter(st => st.schoolIds && st.schoolIds.includes(schoolId));
    }

    if (filteredStudents.length === 0) {
        studentListEl.innerHTML = `<li style="justify-content: center; color: #9CA3AF;">등록된 학생이 없습니다.</li>`;
    } else {
        studentListEl.innerHTML = filteredStudents.map(st => 
            `<li><span>${st.name}</span> <button class="delete-btn" onclick="deleteItem('student', '${st.id}')">삭제</button></li>`
        ).join('');
    }
}

function updateUI() {
    document.getElementById('studentSchoolCheckboxes').innerHTML = (db.schools || []).map(sc => 
        `<label><input type="checkbox" value="${sc.id}"> <span style="display:inline-block; width:10px; height:10px; border-radius:50%; background:${sc.color||'#ccc'}; margin-right:4px;"></span>${sc.name}</label>`
    ).join('');
    
    let schoolOptions = `<option value="COMMON">전체 공통 적용</option>`;
    (db.schools || []).forEach(sc => schoolOptions += `<option value="${sc.id}">${sc.name}</option>`);
    
    const addTargetSchool = document.getElementById('schedTargetSchool');
    const editTargetSchool = document.getElementById('editTargetSchool');
    const currentAddVal = addTargetSchool.value;
    const currentEditVal = editTargetSchool.value;
    
    addTargetSchool.innerHTML = schoolOptions;
    editTargetSchool.innerHTML = schoolOptions;
    
    if(currentAddVal) addTargetSchool.value = currentAddVal;
    if(currentEditVal) editTargetSchool.value = currentEditVal;

    updateStudentSelect('add');

    const schoolSelect = document.getElementById('filter-school');
    const studentContainer = document.getElementById('filter-student-container');
    
    let schoolHtml = `<option value="ALL">전체 일정 보기</option>`;
    (db.schools || []).forEach(sc => {
        const isSelected = currentFilter.schoolId === sc.id ? 'selected' : '';
        schoolHtml += `<option value="${sc.id}" ${isSelected}>${sc.name}</option>`;
    });
    schoolSelect.innerHTML = schoolHtml;

    if(currentFilter.type === 'ALL') {
        studentContainer.style.display = 'none';
        studentContainer.innerHTML = '';
    } else {
        studentContainer.style.display = 'flex';
        const targetStudents = (db.students || []).filter(st => st.schoolIds && st.schoolIds.includes(currentFilter.schoolId));
        if(targetStudents.length === 0) {
            studentContainer.innerHTML = `<span style="font-size: 12px; color: #9CA3AF;">소속된 학생이 없습니다.</span>`;
        } else {
            studentContainer.innerHTML = targetStudents.map(st => {
                const isActive = currentFilter.studentId === st.id ? 'active' : '';
                return `<button class="filter-pill ${isActive}" onclick="toggleStudentFilter('${st.id}')">${st.name}</button>`;
            }).join('');
        }
    }

    document.getElementById('manageSchoolList').innerHTML = (db.schools || []).map(sc => 
        `<li>
            <div style="display: flex; align-items: center; gap: 8px;">
                <input type="color" value="${sc.color || '#10B981'}" onchange="updateSchoolColor('${sc.id}', this.value)" style="width: 24px; height: 24px; padding: 0; border: 1px solid #ccc; border-radius: 4px; cursor: pointer;" title="색상 변경">
                <span>${sc.name}</span>
            </div>
            <button class="delete-btn" onclick="deleteItem('school', '${sc.id}')">삭제</button>
        </li>`
    ).join('');
    
    const manageStudentSchoolSelect = document.getElementById('manageStudentSchoolSelect');
    const currentManageSchool = manageStudentSchoolSelect.value;
    let manageSchoolOptions = `<option value="ALL">전체 학생 보기</option>`;
    (db.schools || []).forEach(sc => manageSchoolOptions += `<option value="${sc.id}">${sc.name}</option>`);
    manageStudentSchoolSelect.innerHTML = manageSchoolOptions;
    if(currentManageSchool) manageStudentSchoolSelect.value = currentManageSchool;
    
    updateManageStudentList();
}

function renderCalendar() { if(calendar) calendar.refetchEvents(); }
function openModal(id) { document.getElementById(id).style.display = 'flex'; }
function closeModal(id) { document.getElementById(id).style.display = 'none'; }

function exportData() { 
    navigator.clipboard.writeText(JSON.stringify(db, null, 2)).then(() => showToast("클립보드에 데이터가 복사되었습니다.")); 
}

async function importData(mode) {
    try {
        const parsed = JSON.parse(document.getElementById('jsonInputData').value);
        await executeDBUpdate(() => {
            if (mode === 'overwrite') {
                db.schools = parsed.schools || [];
                db.students = parsed.students || [];
                db.schedules = parsed.schedules || [];
            } else if (mode === 'append') {
                if(parsed.schools) parsed.schools.forEach(s => { if(!db.schools.find(x => x.id === s.id)) db.schools.push(s) });
                if(parsed.students) parsed.students.forEach(s => { if(!db.students.find(x => x.id === s.id)) db.students.push(s) });
                if(parsed.schedules) parsed.schedules.forEach(s => { if(!db.schedules.find(x => x.id === s.id)) db.schedules.push(s) });
            }
        });
        closeModal('jsonImportModal');
        document.getElementById('jsonInputData').value = '';
        showToast("데이터 반영 및 서버 저장이 완료되었습니다.");
    } catch (e) { alert("JSON 파싱 오류: " + e.message); }
}

function downloadJSONFile() {
    const dataStr = JSON.stringify(db, null, 2);
    const blob = new Blob([dataStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = `schedule_data_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function uploadJSONFile(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(e) {
        document.getElementById('jsonInputData').value = e.target.result;
        openModal('jsonImportModal');
        event.target.value = '';
    };
    reader.readAsText(file);
}