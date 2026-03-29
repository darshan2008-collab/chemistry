$ErrorActionPreference='Stop'

function Call-Api {
  param(
    [string]$Method,
    [string]$Url,
    [hashtable]$Headers,
    [string]$Body
  )

  $params = @{
    Method = $Method
    Uri = $Url
    Headers = $Headers
    SkipHttpErrorCheck = $true
  }

  if ($Body -ne $null -and $Body -ne '') {
    $params.Body = $Body
    if (-not $params.Headers) { $params.Headers = @{} }
    if (-not $params.Headers.ContainsKey('Content-Type')) {
      $params.ContentType = 'application/json'
    }
  }

  $resp = Invoke-WebRequest @params
  $json = $null
  try {
    if ($resp.Content) { $json = $resp.Content | ConvertFrom-Json }
  } catch {}

  [pscustomobject]@{
    Status = [int]$resp.StatusCode
    Json = $json
    Raw = $resp.Content
  }
}

$base = 'http://localhost:10004/api'
$results = New-Object System.Collections.Generic.List[object]

$adminEmail = [string]$env:SMOKE_ADMIN_EMAIL
$adminPassword = [string]$env:SMOKE_ADMIN_PASSWORD
if ([string]::IsNullOrWhiteSpace($adminEmail) -or [string]::IsNullOrWhiteSpace($adminPassword)) {
  throw 'Set SMOKE_ADMIN_EMAIL and SMOKE_ADMIN_PASSWORD environment variables before running this smoke test.'
}

function Add-Result($name, $ok, $detail) {
  $results.Add([pscustomobject]@{
    Name = $name
    Status = if ($ok) { 'PASS' } else { 'FAIL' }
    Detail = $detail
  }) | Out-Null
}

$adminLoginBody = @{ email = $adminEmail; password = $adminPassword } | ConvertTo-Json -Compress
$adminLogin = Call-Api -Method 'POST' -Url "$base/auth/staff/login" -Headers @{} -Body $adminLoginBody
$adminToken = $adminLogin.Json.token
Add-Result 'POST /auth/staff/login (admin)' ($adminLogin.Status -eq 200 -and $adminToken) ("status=$($adminLogin.Status)")
if (-not $adminToken) {
  $results | Format-Table -AutoSize
  exit 1
}
$adminH = @{ Authorization = "Bearer $adminToken" }

$staffEmail = 'smoke.staff'
$seedBody = @{ email = $staffEmail; fullName = 'Smoke Staff'; role = 'Chemistry Teacher'; password = 'SmokePass@123' } | ConvertTo-Json
$seedStaff = Call-Api -Method 'POST' -Url "$base/admin/staff" -Headers $adminH -Body $seedBody
Add-Result 'POST /admin/staff' ($seedStaff.Status -in 200,201) ("status=$($seedStaff.Status)")

$act = Call-Api -Method 'POST' -Url "$base/admin/staff/$staffEmail/activate" -Headers $adminH -Body '{}'
Add-Result 'POST /admin/staff/:email/activate' ($act.Status -eq 200) ("status=$($act.Status)")
$deact = Call-Api -Method 'POST' -Url "$base/admin/staff/$staffEmail/deactivate" -Headers $adminH -Body '{}'
Add-Result 'POST /admin/staff/:email/deactivate' ($deact.Status -eq 200) ("status=$($deact.Status)")
$react = Call-Api -Method 'POST' -Url "$base/admin/staff/$staffEmail/activate" -Headers $adminH -Body '{}'
Add-Result 'POST /admin/staff/:email/activate (re-activate)' ($react.Status -eq 200) ("status=$($react.Status)")
$reset = Call-Api -Method 'PATCH' -Url "$base/admin/staff/$staffEmail/reset-password" -Headers $adminH -Body '{"password":"SmokePass@123"}'
Add-Result 'PATCH /admin/staff/:email/reset-password' ($reset.Status -eq 200) ("status=$($reset.Status)")

$policyBody = @{ permissions = @{ sendAnnouncements = $true; uploadMaterials = $true } } | ConvertTo-Json -Depth 6
$policy = Call-Api -Method 'POST' -Url "$base/admin/role-policies/$staffEmail" -Headers $adminH -Body $policyBody
Add-Result 'POST /admin/role-policies/:email' ($policy.Status -eq 200) ("status=$($policy.Status)")
$audit = Call-Api -Method 'GET' -Url "$base/superadmin/audit-logs?limit=10" -Headers $adminH -Body ''
Add-Result 'GET /superadmin/audit-logs' ($audit.Status -eq 200) ("status=$($audit.Status)")

$staffLogin = Call-Api -Method 'POST' -Url "$base/auth/staff/login" -Headers @{} -Body '{"email":"smoke.staff","password":"SmokePass@123"}'
$staffToken = $staffLogin.Json.token
Add-Result 'POST /auth/staff/login (staff)' ($staffLogin.Status -eq 200 -and $staffToken) ("status=$($staffLogin.Status)")
if (-not $staffToken) {
  $results | Format-Table -AutoSize
  exit 1
}
$staffH = @{ Authorization = "Bearer $staffToken" }

$annBody = @{ title='Smoke Announcement'; message='Hello students'; channelType='global' } | ConvertTo-Json
$ann = Call-Api -Method 'POST' -Url "$base/staff/messages/announcement" -Headers $staffH -Body $annBody
$annId = $ann.Json.announcement.id
Add-Result 'POST /staff/messages/announcement' (($ann.Status -in 200,201) -and $annId) ("status=$($ann.Status)")
$listAnn = Call-Api -Method 'GET' -Url "$base/staff/messages/broadcast" -Headers $staffH -Body ''
Add-Result 'GET /staff/messages/broadcast' ($listAnn.Status -eq 200) ("status=$($listAnn.Status)")
$rcpt = Call-Api -Method 'GET' -Url "$base/staff/messages/broadcast/$annId/read-receipts" -Headers $staffH -Body ''
Add-Result 'GET /staff/messages/broadcast/:id/read-receipts' ($rcpt.Status -eq 200) ("status=$($rcpt.Status)")
$emergBody = @{ title='Emergency Notice'; message='Smoke emergency' } | ConvertTo-Json
$emerg = Call-Api -Method 'POST' -Url "$base/staff/messages/emergency" -Headers $staffH -Body $emergBody
Add-Result 'POST /staff/messages/emergency' (($emerg.Status -in 200,201)) ("status=$($emerg.Status)")

$candidates = @('927625BAD002','927625BCS003','927625BIT003','927625BSC006')
$studentToken = $null
$studentReg = $null
foreach($reg in $candidates){
  $slBody = @{ regNo = $reg; password = $reg } | ConvertTo-Json
  $sl = Call-Api -Method 'POST' -Url "$base/auth/student/login" -Headers @{} -Body $slBody
  if ($sl.Status -eq 200 -and $sl.Json.token) {
    $studentToken = $sl.Json.token
    $studentReg = $reg
    break
  }
}
$studentLoginDetail = 'no candidate matched'
if ($studentReg) { $studentLoginDetail = "reg=$studentReg" }
Add-Result 'POST /auth/student/login' ($studentToken -ne $null) $studentLoginDetail
if (-not $studentToken) {
  $results | Format-Table -AutoSize
  exit 1
}
$studentH = @{ Authorization = "Bearer $studentToken" }

$studentAnn = Call-Api -Method 'GET' -Url "$base/student/messages/announcements" -Headers $studentH -Body ''
Add-Result 'GET /student/messages/announcements' ($studentAnn.Status -eq 200) ("status=$($studentAnn.Status)")
$firstAnnId = $null
if ($studentAnn.Json.announcements -and $studentAnn.Json.announcements.Count -gt 0) {
  $firstAnnId = $studentAnn.Json.announcements[0].id
}
if ($firstAnnId) {
  $markRead = Call-Api -Method 'POST' -Url "$base/student/messages/$firstAnnId/read" -Headers $studentH -Body '{}'
  Add-Result 'POST /student/messages/:id/read' ($markRead.Status -eq 200) ("status=$($markRead.Status)")
} else {
  Add-Result 'POST /student/messages/:id/read' $false 'no announcement id available'
}
$studentEmerg = Call-Api -Method 'GET' -Url "$base/student/messages/emergency" -Headers $studentH -Body ''
Add-Result 'GET /student/messages/emergency' ($studentEmerg.Status -eq 200) ("status=$($studentEmerg.Status)")

$studentSubjects = Call-Api -Method 'GET' -Url "$base/student/subjects" -Headers $studentH -Body ''
$qaSubjectId = $null
if ($studentSubjects.Status -eq 200 -and $studentSubjects.Json.subjects -and $studentSubjects.Json.subjects.Count -gt 0) {
  $qaSubjectId = $studentSubjects.Json.subjects[0].id
}
if (-not $qaSubjectId) {
  $allSubjects = Call-Api -Method 'GET' -Url "$base/admin/subjects" -Headers $adminH -Body ''
  if ($allSubjects.Status -eq 200 -and $allSubjects.Json.subjects -and $allSubjects.Json.subjects.Count -gt 0) {
    $qaSubjectId = $allSubjects.Json.subjects[0].id
  }
}

$qaStaffEmail = $staffEmail
if ($qaSubjectId) {
  $mapStaffSubjBody = @{ staffEmail = $qaStaffEmail; subjectId = [int]$qaSubjectId } | ConvertTo-Json
  $mapStaffSubj = Call-Api -Method 'POST' -Url "$base/admin/assign/staff-subject" -Headers $adminH -Body $mapStaffSubjBody
  Add-Result 'POST /admin/assign/staff-subject' ($mapStaffSubj.Status -eq 200) ("status=$($mapStaffSubj.Status)")

  $mapStudentSubjBody = @{ regNo = $studentReg; subjectId = [int]$qaSubjectId } | ConvertTo-Json
  $mapStudentSubj = Call-Api -Method 'POST' -Url "$base/admin/assign/student-subject" -Headers $adminH -Body $mapStudentSubjBody
  Add-Result 'POST /admin/assign/student-subject' ($mapStudentSubj.Status -eq 200) ("status=$($mapStudentSubj.Status)")

  $mapTripleBody = @{ regNo = $studentReg; staffEmail = $qaStaffEmail; subjectId = [int]$qaSubjectId } | ConvertTo-Json
  $mapTriple = Call-Api -Method 'POST' -Url "$base/admin/assign/student-staff-subject" -Headers $adminH -Body $mapTripleBody
  Add-Result 'POST /admin/assign/student-staff-subject' ($mapTriple.Status -eq 200) ("status=$($mapTriple.Status)")
}

$threadId = $null
if ($qaSubjectId -and $qaStaffEmail) {
  $qaCreateBody = @{ subjectId = $qaSubjectId; staffEmail = $qaStaffEmail; title = 'Smoke QA'; message = 'Is chapter 5 test this week?' } | ConvertTo-Json
  $qaCreate = Call-Api -Method 'POST' -Url "$base/student/qa/threads" -Headers $studentH -Body $qaCreateBody
  $threadId = $qaCreate.Json.thread.id
  Add-Result 'POST /student/qa/threads' (($qaCreate.Status -in 200,201) -and $threadId) ("status=$($qaCreate.Status)")
} else {
  Add-Result 'POST /student/qa/threads' $false 'no valid subject/staff mapping for student'
}
$qaListStudent = Call-Api -Method 'GET' -Url "$base/student/qa/threads" -Headers $studentH -Body ''
Add-Result 'GET /student/qa/threads' ($qaListStudent.Status -eq 200) ("status=$($qaListStudent.Status)")

if ($threadId) {
  $qaMsgsStudent = Call-Api -Method 'GET' -Url "$base/student/qa/threads/$threadId/messages" -Headers $studentH -Body ''
  Add-Result 'GET /student/qa/threads/:id/messages' ($qaMsgsStudent.Status -eq 200) ("status=$($qaMsgsStudent.Status)")

  $qaListStaff = Call-Api -Method 'GET' -Url "$base/staff/qa/threads" -Headers $staffH -Body ''
  Add-Result 'GET /staff/qa/threads' ($qaListStaff.Status -eq 200) ("status=$($qaListStaff.Status)")

  $qaReply = Call-Api -Method 'POST' -Url "$base/staff/qa/threads/$threadId/reply" -Headers $staffH -Body '{"message":"Yes, prepare equilibrium and kinetics.","closeThread":false}'
  Add-Result 'POST /staff/qa/threads/:id/reply' ($qaReply.Status -eq 200) ("status=$($qaReply.Status)")

  $qaMsgsStaff = Call-Api -Method 'GET' -Url "$base/staff/qa/threads/$threadId/messages" -Headers $staffH -Body ''
  Add-Result 'GET /staff/qa/threads/:id/messages' ($qaMsgsStaff.Status -eq 200) ("status=$($qaMsgsStaff.Status)")
}

$results | Format-Table -AutoSize
