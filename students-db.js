// ── Student Database (extracted from register) ────────────────
// Register Number → Full Name
const STUDENTS_DB = {
  // ── BAD  A7 Series ──────────────────────────────────────────────
  "927625BAD002": "ABARNA S",
  "927625BAD004": "ABISHEAK S",
  "927625BAD016": "ASWIN B",
  "927625BAD019": "BATHIRINATH S S",
  "927625BAD025": "DAKSHA V",
  "927625BAD026": "DARSHAN K",
  "927625BAD034": "DHARANIDHARAN B",
  "927625BAD045": "ELANGO M",
  "927625BAD050": "GOWSIKAN K",
  "927625BAD051": "GURU PRIYA P S",
  "927625BAD053": "HARENISHA M",
  "927625BAD054": "HARIHARASUDHAN A M",
  "927625BAD060": "HARRIS BENADICT A",
  "927625BAD064": "HIBASHINI E",
  "927625BAD069": "JOSHUA L",
  "927625BAD073": "KANIKA G",
  "927625BAD074": "KANISHKA R",
  "927625BAD077": "KARTHIKEYAN S",
  "927625BAD078": "KAVIYA P",
  "927625BAD080": "KEERTHIVASAN S L",
  "927625BAD085": "KOWSIKA T",
  "927625BAD086": "LEKA SRI K",
  "927625BAD087": "LEKAA SREENITHI S",
  "927625BAD088": "LOKESH S",
  "927625BAD089": "MADHUMITHA T",
  "927625BAD092": "MOHAMED NAZEEM M",
  "927625BAD101": "NARESH V",
  "927625BAD103": "NETRA M",
  "927625BAD108": "PARANISRI Y",
  "927625BAD110": "POOJA S",
  "927625BAD111": "POOVIZHI S",
  "927625BAD113": "PRAJITHA T",
  "927625BAD116": "PRANESH T",
  "927625BAD117": "PRASANTH V",
  "927625BAD125": "M RITHIK ROSAN",
  "927625BAD129": "RUTHRAMOORTHY S B",
  "927625BAD132": "SAKTHIKA SRI G K",
  "927625BAD138": "SANJU G",
  "927625BAD150": "SHYLESH R",
  "927625BAD162": "SUJIBALA A",
  "927625BAD164": "SUWETHA M",
  "927625BAD166": "SWATHIKA S",
  "927625BAD171": "THIROSHIKA A M",
  "927625BAD172": "UDHAYAKRISHNAN R",
  "927625BAD176": "VENKATNATHAN M",
  "927625BAD178": "VIGNESH K",
  "927625BAD185": "VYSHNAVI M",
  // ── BAM  A7 Series ──────────────────────────────────────────────
  "927625BAM003": "AJEYHARSAN P",
  "927625BAM004": "AKSHAYA LAKSHMI C",
  "927625BAM005": "ANBARASU S",
  "927625BAM007": "BALAJI K",
  "927625BAM009": "GOBIKA M",
  "927625BAM013": "HARSHAN T V",
  "927625BAM017": "KRISHNA KUMAR P V",
  "927625BAM019": "LOHITH M",
  "927625BAM029": "PRAVIN KUMAR SURESH KUMAR",
  "927625BAM046": "SHRI HARINI A",
  "927625BAM050": "SRI NITHI T",
  "927625BAM052": "SUDHARSAN N S",
  "927625BAM058": "THANYA G",
  "927625BAM061": "VIKRAM S",
  "927625BAM063": "YUVAHARSHINI E",
  // ── BCS Series (A3) ───────────────────────────────────────
  "927625BCS0003": "ABITHA M",
  "927625BCS003": "ABITHA M",
  "927625BCS005": "AISHWARYA S",
  "927625BCS007": "AKSHARAA S",
  "927625BCS011": "ANUREGA C",
  "927625BCS016": "BHUVANA R",
  "927625BCS019": "DANUJA S",
  "927625BCS021": "DARSHINI S P",
  "927625BCS024": "DEVADHARSAN M",
  "927625BCS040": "GANESH R",
  "927625BCS041": "GAYATHRI S",
  "927625BCS047": "HARISH K",
  "927625BCS050": "HEMASRI V",
  "927625BCS059": "JENISH OSWIN J",
  "927625BCS063": "KANIKA K",
  "927625BCS079": "KIRUSHIKA J",
  "927625BCS080": "KIRUTHIK MITHRAA J",
  "927625BCS093": "MENAGA P",
  "927625BCS097": "MOHIT S",
  "927625BCS098": "MOUSIYA M",
  "927625BCS103": "NETHESSKUMAAR K",
  "927625BCS112": "NITHISH R",
  "927625BCS118": "PONNARASAN P",
  "927625BCS120": "PRAMOTH L",
  "927625BCS123": "PRATEEKSHA V",
  "927625BCS125": "PRAVEENA R",
  "927625BCS135": "ROHITH ANBARASAN",
  "927625BCS148": "SHAAI SHANKAR S",
  "927625BCS157": "SREEJA A",
  "927625BCS170": "THANYAA K K",
  "927625BCS172": "THARUN ATHTHYA A",
  "927625BCS173": "THARUN V P",
  "927625BCS182": "VIJAYARASU K",
  "927625BCS184": "VIJITHA K",
  // ── BIT Series (A3) ───────────────────────────────────────
  "927625BIT003": "AKILAN V",
  "927625BIT005": "AKSHAY JOE S J",
  "927625BIT006": "ANUSHRI M",
  "927625BIT022": "DHANUSKODI A",
  "927625BIT027": "DIBAKAR R",
  "927625BIT042": "JANANI S",
  "927625BIT047": "KANISHKA R",
  "927625BIT049": "KARUN S",
  "927625BIT052": "LAVANYA S",
  "927625BIT053": "LOGESH S M",
  "927625BIT063": "NARMADHA M V",
  "927625BIT068": "NAVEENKUMAR K",
  "927625BIT069": "NEHA S",
  "927625BIT072": "NIHIL SELVAN S",
  "927625BIT082": "POOVENDHIRAN V",
  "927625BIT086": "PRANISHKA R M",
  "927625BIT092": "RAJASREE K",
  "927625BIT093": "REVANTH VIJAY S",
  "927625BIT095": "SAMIKSHA C A",
  "927625BIT105": "SHRIDAR V",
  "927625BIT107": "SIVANESH C",
  "927625BIT108": "SRIDHARAN M",
  "927625BIT121": "VISHNU ANANDHAN N",
  // ── BSC Series (A3) ───────────────────────────────────────
  "927625BSC006": "BABURAJ KANNA P",
  "927625BSC007": "BALAKRISHNA S",
  "927625BSC015": "HARSHEN R",
  "927625BSC027": "KOWSIK P",
  "927625BSC034": "MOHAN KUMAR V",
  "927625BSC053": "SARAN B",
};

// ── Password helpers (localStorage) ──────────────────────────
const PW_KEY = 'chemtest_student_pw';
const CHANGED_KEY = 'chemtest_pw_changed';

function getPasswords() {
  try { return JSON.parse(localStorage.getItem(PW_KEY)) || {}; }
  catch { return {}; }
}
function savePasswords(obj) { localStorage.setItem(PW_KEY, JSON.stringify(obj)); }

function getStudentPassword(regNo) {
  const pws = getPasswords();
  return pws[regNo] || regNo; // default password = register number
}
function setStudentPassword(regNo, newPw) {
  const pws = getPasswords();
  pws[regNo] = newPw;
  savePasswords(pws);
}
function hasChangedPassword(regNo) {
  try { return !!(JSON.parse(localStorage.getItem(CHANGED_KEY)) || {})[regNo]; }
  catch { return false; }
}
function markPasswordChanged(regNo) {
  const obj = JSON.parse(localStorage.getItem(CHANGED_KEY) || '{}');
  obj[regNo] = true;
  localStorage.setItem(CHANGED_KEY, JSON.stringify(obj));
}

// ── Session helpers ───────────────────────────────────────────
function getStudentSession() {
  try { return JSON.parse(sessionStorage.getItem('chemtest_student') || 'null'); }
  catch { return null; }
}
function setStudentSession(regNo, token = null, nameOverride = null) {
  sessionStorage.setItem('chemtest_student', JSON.stringify({
    regNo,
    name: nameOverride || STUDENTS_DB[regNo],
    token,
    loggedInAt: new Date().toISOString()
  }));
}
function clearStudentSession() { sessionStorage.removeItem('chemtest_student'); }
function requireStudentAuth() {
  const s = getStudentSession();
  if (!s || !s.token) { window.location.href = 'login.html'; }
}

function getStaffSession() {
  try { return JSON.parse(sessionStorage.getItem('chemtest_staff') || 'null'); }
  catch { return null; }
}
function setStaffSession(staff) {
  sessionStorage.setItem('chemtest_staff', JSON.stringify({
    ...staff,
    loggedInAt: new Date().toISOString(),
  }));
}
function clearStaffSession() { sessionStorage.removeItem('chemtest_staff'); }
