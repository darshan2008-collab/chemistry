FROM nginx:1.27-alpine

COPY nginx/default.conf /etc/nginx/conf.d/default.conf
COPY index.html /usr/share/nginx/html/index.html
COPY login.html /usr/share/nginx/html/login.html
COPY student-login.html /usr/share/nginx/html/student-login.html
COPY staff-login.html /usr/share/nginx/html/staff-login.html
COPY superadmin-login.html /usr/share/nginx/html/superadmin-login.html
COPY staff-dashboard.html /usr/share/nginx/html/staff-dashboard.html
COPY superadmin-dashboard.html /usr/share/nginx/html/superadmin-dashboard.html
COPY grade.html /usr/share/nginx/html/grade.html

COPY grade.css /usr/share/nginx/html/grade.css
COPY login.css /usr/share/nginx/html/login.css
COPY staff-dashboard.css /usr/share/nginx/html/staff-dashboard.css
COPY staff-login.css /usr/share/nginx/html/staff-login.css
COPY superadmin-dashboard.css /usr/share/nginx/html/superadmin-dashboard.css
COPY superadmin-login.css /usr/share/nginx/html/superadmin-login.css
COPY student.css /usr/share/nginx/html/student.css
COPY student-login.css /usr/share/nginx/html/student-login.css

COPY grade.js /usr/share/nginx/html/grade.js
COPY login.js /usr/share/nginx/html/login.js
COPY staff-dashboard.js /usr/share/nginx/html/staff-dashboard.js
COPY staff-login.js /usr/share/nginx/html/staff-login.js
COPY superadmin-dashboard.js /usr/share/nginx/html/superadmin-dashboard.js
COPY superadmin-login.js /usr/share/nginx/html/superadmin-login.js
COPY student.js /usr/share/nginx/html/student.js
COPY student-login.js /usr/share/nginx/html/student-login.js
COPY students-db.js /usr/share/nginx/html/students-db.js
