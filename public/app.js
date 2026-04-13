    let _supabase; // Initialized in init()

    class WritingDB {
        constructor() {
            this.currentUser = null;
        }

        async init() {
            try {
                // Fetch config from our Express server
                const response = await fetch('/api/config');
                if (!response.ok) throw new Error('Failed to fetch config');
                const config = await response.json();

                // Validate URL format (must be a valid Supabase URL)
                if (!config.url || !config.url.startsWith('http')) {
                    this.showSetupWarning();
                    return null;
                }

                _supabase = supabase.createClient(config.url, config.key);

                const { data: { session }, error } = await _supabase.auth.getSession();
                if (error) throw error;
                if (session) {
                    this.currentUser = {
                        id: session.user.id,
                        email: session.user.email,
                        name: session.user.user_metadata.full_name,
                        role: session.user.user_metadata.role
                    };

                    // SELF-HEALING: Ensure a profile exists for this user
                    const { data: profile } = await _supabase.from('profiles').select('*').eq('id', session.user.id).single();
                    if (!profile) {
                         await _supabase.from('profiles').insert([{
                            id: session.user.id,
                            email: this.currentUser.email,
                            name: this.currentUser.name,
                            role: this.currentUser.role
                         }]);
                    }
                }
                return this.currentUser;
            } catch (err) {
                console.error("Initialization Error:", err);
                this.showSetupWarning();
                return null;
            }
        }

        showSetupWarning() {
            const authScreen = document.getElementById('authScreen');
            if (!authScreen) return;
            
            const warning = document.createElement('div');
            warning.className = 'setup-warning';
            warning.style.cssText = 'background: #fff4f4; border: 1px solid #ffcdd2; color: #b71c1c; padding: 20px; border-radius: 12px; margin-bottom: 24px; font-weight: 500; line-height: 1.6;';
            warning.innerHTML = `
                <h3 style="margin-top:0">⚠️ Configuration Required</h3>
                <p>It looks like your Supabase connection is not set up correctly.</p>
                <ol style="margin-bottom:0">
                    <li>Create a <code>.env</code> file in the project root.</li>
                    <li>Add your <code>SUPABASE_URL</code> and <code>SUPABASE_ANON_KEY</code>.</li>
                    <li>Restart the server using <code>node server.js</code>.</li>
                </ol>
            `;
            authScreen.prepend(warning);
        }

        async registerUser(email, password, name, role) {
            if (!_supabase) return { success: false, message: "Database not initialized. Check your configuration." };
            const { data, error } = await _supabase.auth.signUp({
                email,
                password,
                options: {
                    data: { full_name: name, role: role }
                }
            });
            if (error) return { success: false, message: error.message };
            
            // NEW: Create a public profile entry so the teacher can see the student in the list
            await _supabase.from('profiles').insert([{ 
                id: data.user.id, 
                email: email, 
                name: name, 
                role: role 
            }]);

            return { success: true };
        }

        async getProfiles() {
            const { data, error } = await _supabase
                .from('profiles')
                .select('*')
                .eq('role', 'student')
                .order('name', { ascending: true });
            return data || [];
        }

        async loginUser(email, password) {
            if (!_supabase) return { success: false, message: "Database not initialized. Check your configuration." };
            const { data, error } = await _supabase.auth.signInWithPassword({ email, password });
            if (error) return { success: false, message: error.message };
            
            this.currentUser = {
                id: data.user.id,
                email: data.user.email,
                name: data.user.user_metadata.full_name,
                role: data.user.user_metadata.role
            };
            return { success: true, user: this.currentUser };
        }

        getCurrentUser() {
            return this.currentUser;
        }

        async logoutUser() {
            await _supabase.auth.signOut();
            this.currentUser = null;
        }

        async createTask(title, instructions, checklistText, createdBy) {
            const checklist = checklistText.split('\n').filter(item => item.trim()).map(text => ({ text, checked: false }));
            
            const { data: task, error: taskError } = await _supabase
                .from('tasks')
                .insert([{ title, instructions, checklist, created_by: createdBy, status: 'draft' }])
                .select()
                .single();

            if (taskError) throw taskError;

            // Create initial revision
            await this.addRevision(task.id, instructions, createdBy);
            return task;
        }

        async getTasks() {
            const { data, error } = await _supabase
                .from('tasks')
                .select('*')
                .order('created_at', { ascending: false });
            if (error) return [];
            return data;
        }

        async getTask(taskId) {
            const { data, error } = await _supabase
                .from('tasks')
                .select('*')
                .eq('id', taskId)
                .single();
            return data;
        }

        async renameProfile(userId, newName) {
            const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-5][0-9a-f]{3}-[089ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId);
            
            try {
                if (isUUID) {
                    // 1. Try to update or create profile (Requires UUID)
                    const { data: profile } = await _supabase.from('profiles').select('*').eq('id', userId).single();
                    if (profile) {
                        await _supabase.from('profiles').update({ name: newName }).eq('id', userId);
                    } else {
                        await _supabase.from('profiles').insert([{ id: userId, name: newName, role: 'student' }]);
                    }
                }
                
                // 2. Always update checklist records (Works with both UUID and Name-based IDs)
                const { data: existing } = await _supabase.from('student_checklists').select('*').eq('student_id', userId).limit(1);
                if (existing && existing.length > 0) {
                    await _supabase.from('student_checklists').update({ student_name: newName }).eq('student_id', userId);
                } else if (!isUUID) {
                    // Create legacy marker for name-based IDs
                    await _supabase.from('student_checklists').insert([{ 
                        student_id: userId, 
                        student_name: newName, 
                        task_id: '00000000-0000-0000-0000-000000000000',
                        items: [] 
                    }]);
                }
            } catch (err) {
                console.error("Rename failed:", err);
                alert("Could not rename student. Check Supabase permissions.");
            }
            return true;
        }

        async deleteTask(taskId) {
            const { error } = await _supabase
                .from('tasks')
                .delete()
                .eq('id', taskId);
            if (error) throw error;
            return true;
        }

        async renameTask(taskId, newTitle) {
            const { error } = await _supabase
                .from('tasks')
                .update({ title: newTitle })
                .eq('id', taskId);
            if (error) throw error;
            return true;
        }

        async updateChecklist(taskId, checklist) {
            await _supabase
                .from('tasks')
                .update({ checklist })
                .eq('id', taskId);
        }

        async addRevision(taskId, content, author) {
            const { data, error } = await _supabase
                .from('revisions')
                .insert([{ task_id: taskId, content, author }])
                .select()
                .single();
            return data;
        }

        async getTaskRevisions(taskId) {
            const { data, error } = await _supabase
                .from('revisions')
                .select('*')
                .eq('task_id', taskId)
                .order('timestamp', { ascending: true });
            return data || [];
        }

        async addComment(taskId, author, text) {
            const { data, error } = await _supabase
                .from('comments')
                .insert([{ task_id: taskId, author, text }])
                .select()
                .single();
            return data;
        }

        async getStudentChecklist(taskId, studentId) {
            const { data, error } = await _supabase
                .from('student_checklists')
                .select('*')
                .eq('task_id', taskId)
                .eq('student_id', studentId)
                .single();
            return data;
        }

        async updateStudentChecklist(taskId, studentId, studentName, items) {
            const { data, error } = await _supabase
                .from('student_checklists')
                .upsert({ 
                    task_id: taskId, 
                    student_id: studentId, 
                    student_name: studentName,
                    items: items,
                    updated_at: new Date().toISOString()
                }, { onConflict: 'task_id,student_id' });
            return data;
        }

        async getAllStudentChecklists() {
            const { data, error } = await _supabase
                .from('student_checklists')
                .select('*');
            if (error) console.error("Error fetching checklists:", error);
            return data || [];
        }

        async getAllRevisions() {
            const { data, error } = await _supabase
                .from('revisions')
                .select('*');
            if (error) console.error("Error fetching all revisions:", error);
            return data || [];
        }

        async getTaskComments(taskId) {
            const { data, error } = await _supabase
                .from('comments')
                .select('*')
                .eq('task_id', taskId)
                .order('timestamp', { ascending: true });
            return data || [];
        }
    }

  const db = new WritingDB();
  let currentTaskId = null;
  let editMode = false;

  // Initialize DB and Check Session
  window.addEventListener('load', async () => {
    const user = await db.init();
    if (user) {
      document.getElementById('authScreen').classList.add('hidden');
      document.getElementById('appContainer').classList.remove('hidden');
      updateUserProfileUI(user);
      loadDashboard();
    }
  });

  function updateUserProfileUI(user) {
    document.getElementById('userNameDisplay').textContent = user.name;
    document.getElementById('userRoleDisplay').textContent = user.role;
    document.getElementById('userAvatarIcon').textContent = user.name.charAt(0).toUpperCase();
    
    // Hide teacher-only features from students
    const newTaskBtn = document.getElementById('newTaskBtn');
    const highlightBtn = document.getElementById('highlightBtn');
    
    if (user.role === 'teacher') {
      newTaskBtn.classList.remove('hidden');
      highlightBtn.classList.remove('hidden');
      document.getElementById('editBtn').classList.remove('hidden');
      document.getElementById('teacherNav').classList.remove('hidden');
    } else {
      newTaskBtn.classList.add('hidden');
      highlightBtn.classList.add('hidden');
      document.getElementById('editBtn').classList.add('hidden');
      document.getElementById('teacherNav').classList.add('hidden');
    }
  }

  function showView(viewName) {
    document.getElementById('dashboardView').classList.add('hidden');
    document.getElementById('studentsView').classList.add('hidden');
    document.getElementById('editorView').classList.add('hidden');
    
    // Deactivate all sidebar items
    document.querySelectorAll('.sidebar-item').forEach(el => el.classList.remove('active'));

    if (viewName === 'dashboard') {
      document.getElementById('dashboardView').classList.remove('hidden');
      loadDashboard();
    } else if (viewName === 'students') {
      document.getElementById('studentsView').classList.remove('hidden');
      loadStudentsView();
    }
  }

  // Auth functions
  function switchTab(tab) {
    const loginForm = document.getElementById('loginForm');
    const signupForm = document.getElementById('signupForm');
    const tabs = document.querySelectorAll('.auth-tab');

    if (tab === 'login') {
      loginForm.classList.remove('hidden');
      signupForm.classList.add('hidden');
      tabs[0].classList.add('active');
      tabs[1].classList.remove('active');
    } else {
      loginForm.classList.add('hidden');
      signupForm.classList.remove('hidden');
      tabs[0].classList.remove('active');
      tabs[1].classList.add('active');
    }
  }

  function showMessage(elementId, message, isError = false) {
    const element = document.getElementById(elementId);
    element.innerHTML = `<div class="${isError ? 'error-message' : 'success-message'}">${message}</div>`;
    setTimeout(() => {
      element.innerHTML = '';
    }, 4000);
  }

  async function handleLogin() {
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;

    if (!email || !password) {
      showMessage('loginMessage', 'Please fill in all fields', true);
      return;
    }

    const result = await db.loginUser(email, password);
    if (result.success) {
      const user = result.user;
      document.getElementById('authScreen').classList.add('hidden');
      document.getElementById('appContainer').classList.remove('hidden');
      updateUserProfileUI(user);
      await loadDashboard();
    } else {
      showMessage('loginMessage', result.message, true);
    }
  }

  async function handleSignup() {
    const name = document.getElementById('signupName').value.trim();
    const email = document.getElementById('signupEmail').value.trim();
    const password = document.getElementById('signupPassword').value;
    const role = document.getElementById('signupRole').value;

    if (!name || !email || !password) {
      showMessage('signupMessage', 'Please fill in all fields', true);
      return;
    }

    if (password.length < 6) {
      showMessage('signupMessage', 'Password must be at least 6 characters long', true);
      return;
    }

    const result = await db.registerUser(email, password, name, role);
    if (result.success) {
      showMessage('signupMessage', 'Account created! Please log in.', false);
      setTimeout(() => switchTab('login'), 2000);
    } else {
      // Handle the case where the user might already exist
      let msg = result.message;
      if (msg.includes('already registered')) {
        msg = "Email already in use. Try logging in!";
      }
      showMessage('signupMessage', msg, true);
    }
  }

  async function logout() {
    await db.logoutUser();
    location.reload();
  }

  async function loadDashboard() {
    const taskGrid = document.getElementById('taskGrid');
    const tasksList = document.getElementById('tasksList');

    taskGrid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 40px;">Loading tasks...</div>';
    tasksList.innerHTML = '';

    const tasks = await db.getTasks();
    taskGrid.innerHTML = '';

    for (const task of tasks) {
      const revisions = await db.getTaskRevisions(task.id);
      const html = `
        <div class="task-card" onclick="openTask('${task.id}')">
          <h3>${task.title}</h3>
          <p>${task.instructions.substring(0, 60)}...</p>
          <div class="task-meta">
            <span class="badge ${task.status}">${task.status}</span>
            <span>${revisions.length} revisions</span>
          </div>
        </div>
      `;
      taskGrid.innerHTML += html;

      const sidebarItem = document.createElement('div');
      sidebarItem.className = 'sidebar-item';
      sidebarItem.textContent = task.title.substring(0, 20) + '...';
      sidebarItem.onclick = () => openTask(task.id);
      tasksList.appendChild(sidebarItem);
    }
  }

  async function openTask(taskId) {
    currentTaskId = taskId;
    const task = await db.getTask(taskId);
    const revisions = await db.getTaskRevisions(taskId);
    const currentRevision = revisions[revisions.length - 1];

    document.getElementById('dashboardView').classList.add('hidden');
    document.getElementById('editorView').classList.remove('hidden');

    document.getElementById('taskTitle').textContent = task.title;
    document.getElementById('revisionLabel').textContent = `Revision ${revisions.length} by ${currentRevision?.author || 'Unknown'}`;
    
    // Load content with highlights if enabled
    await renderDraftContent(taskId);

    document.getElementById('editBtn').classList.remove('hidden');

    // Show/hide teacher-only sections based on role
    const user = db.getCurrentUser();
    const isTeacher = user.role === 'teacher';
    
    // Toggle focused mode for students
    const editorContainer = document.querySelector('.editor-container');
    editorContainer.classList.toggle('focused-mode', !isTeacher);

    document.getElementById('taskActionButtons').classList.toggle('hidden', !isTeacher);
    document.getElementById('feedbackSection').classList.toggle('hidden', !isTeacher);
    document.getElementById('commentsSection').classList.remove('hidden'); // Everyone can see comments section now
    document.getElementById('revisionsSection').classList.toggle('hidden', !isTeacher);

    if (isTeacher) {
      await populateStudentSelector(taskId);
    }

    // Auto-enable editing for everyone
    const editor = document.getElementById('draftText');
    editor.contentEditable = true;
    editor.classList.add('editing');
    
    loadChecklistItems([]); // Clear checklist until student is selected
    await loadComments(taskId);
    await loadRevisions(taskId);
  }

  async function populateStudentSelector(taskId) {
    const selector = document.getElementById('studentSelector');
    selector.innerHTML = '<option value="">Select Student...</option>';
    
    // Find all unique students who have contributed revisions
    const revisions = await db.getTaskRevisions(taskId);
    const students = new Map(); // Use Map to keep unique student names/IDs (simulated by author name here for simplicity)
    
    // In a real app with proper IDs, we'd use session.user.id. 
    // Here we'll group by revision author names to identify students.
    revisions.forEach(rev => {
       if (rev.author) students.set(rev.author, rev.author); 
    });

    students.forEach((name, id) => {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = name;
      selector.appendChild(opt);
    });
  }

  async function loadStudentChecklist() {
    const studentId = document.getElementById('studentSelector').value;
    if (!studentId) {
      loadChecklistItems([]);
      return;
    }

    const task = await db.getTask(currentTaskId);
    const savedProgress = await db.getStudentChecklist(currentTaskId, studentId);
    
    // Merge master checklist template with student's saved progress
    const items = task.checklist.map((templateItem, idx) => {
      const savedItem = savedProgress?.items?.[idx];
      return {
        text: typeof templateItem === 'object' ? templateItem.text : templateItem,
        checked: savedItem ? savedItem.checked : false
      };
    });

    loadChecklistItems(items);
  }

  async function loadStudentsView() {
    const listBody = document.getElementById('studentProgressBody');
    listBody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:40px;">Deep-scanning database for any activity...</td></tr>';
    
    // Direct, independent fetches - even if tasks are empty, these will find people in the logs
    const [profiles, allProgress, allRevisions] = await Promise.all([
        db.getProfiles(),
        db.getAllStudentChecklists(),
        db.getAllRevisions()
    ]);
    
    // Unified Student Map
    const studentMap = new Map();

    // 1. Add people found in checklists (These have priority names set by teacher)
    allProgress.forEach(entry => {
        studentMap.set(entry.student_id, { 
            id: entry.student_id, 
            name: entry.student_name, // This is the 'Renamed' name
            email: 'Legacy Account', 
            lastActive: entry.updated_at,
            completed: 0,
            total: 0
        });
        const stats = studentMap.get(entry.student_id);
        const taskItems = entry.items || [];
        stats.completed = taskItems.filter(i => i.checked).length;
        stats.total = taskItems.length;
    });

    // 2. Add people from profiles (Real accounts) - Overwrites legacy if ID matches
    profiles.forEach(p => {
        const stats = studentMap.get(p.id) || { completed: 0, total: 0 };
        studentMap.set(p.id, { 
            id: p.id, 
            name: p.name, 
            email: p.email, 
            lastActive: p.created_at,
            completed: stats.completed,
            total: stats.total
        });
    });

    // 3. Add remains from revisions (Final fallback)
    allRevisions.forEach(rev => {
        if (!studentMap.has(rev.author)) {
             studentMap.set(rev.author, { id: rev.author, name: rev.author, email: 'Active Writer', lastActive: rev.timestamp, completed: 0, total: 0 });
        }
        const stats = studentMap.get(rev.author);
        if (new Date(rev.timestamp) > new Date(stats.lastActive)) stats.lastActive = rev.timestamp;
    });

    listBody.innerHTML = '';
    const sortedStudents = Array.from(studentMap.values()).sort((a,b) => new Date(b.lastActive) - new Date(a.lastActive));
    
    if (sortedStudents.length === 0) {
        listBody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:40px; color:#999;">No students found in the database.</td></tr>';
        return;
    }

    sortedStudents.forEach(student => {
        const completed = student.completed || 0;
        const total = student.total || 0;
        const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
        const status = total > 0 ? (percent === 100 ? '✅ Completed' : '✍️ Active') : '🆕 Not Evaluated';
        
        const row = `
            <tr>
              <td>
                <div style="display:flex; align-items:center; gap:8px;">
                    <div style="font-weight:600;">${student.name}</div>
                    <button class="btn-icon" style="padding:2px; font-size:10px;" onclick="promptRenameStudent('${student.id}', '${student.name}')" title="Rename Student">✏️</button>
                </div>
                <div style="font-size:11px; color:#999;">${student.email || 'System Account'}</div>
              </td>
              <td style="color:#666;">${new Date(student.lastActive).toLocaleDateString()}</td>
              <td>
                <div style="display:flex; align-items:center; gap:12px;">
                  <div class="progress-bar-bg">
                    <div class="progress-bar-fill" style="width: ${percent}%"></div>
                  </div>
                  <span style="font-size:12px; font-weight:600; color:#667eea;">${percent}%</span>
                </div>
                <div style="font-size:10px; color:#999; margin-top:4px;">${total > 0 ? `${completed} of ${total} total items` : 'No feedback given yet'}</div>
              </td>
              <td><span class="badge ${total > 0 ? 'teacher' : 'student'}" style="font-size:10px;">${status}</span></td>
            </tr>
        `;
        listBody.innerHTML += row;
    });
  }

  let highlightsEnabled = false;

  async function toggleHighlights() {
    highlightsEnabled = !highlightsEnabled;
    const btn = document.getElementById('highlightBtn');
    btn.classList.toggle('active', highlightsEnabled);
    btn.textContent = highlightsEnabled ? '🏷️ Hide Authors' : '🏷️ Show Authors';
    
    document.getElementById('authorLegend').classList.toggle('hidden', !highlightsEnabled);
    document.getElementById('draftText').classList.toggle('show-highlights', highlightsEnabled);
    
    await renderDraftContent(currentTaskId);
  }

  function getAuthorColor(name) {
    if (!name) return { bg: '#eee', border: '#ccc' };
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    const h = Math.abs(hash) % 360;
    return {
      bg: `hsla(${h}, 70%, 90%, 0.8)`,
      border: `hsla(${h}, 70%, 40%, 1)`
    };
  }

  async function renderDraftContent(taskId) {
    const revisions = await db.getTaskRevisions(taskId);
    const editor = document.getElementById('draftText');
    const legendItems = document.getElementById('authorLegendItems');
    
    if (revisions.length === 0) return;
    
    const currentRevision = revisions[revisions.length - 1];

    if (!highlightsEnabled) {
      editor.textContent = currentRevision.content;
      return;
    }

    // Authorship detection logic
    const dmp = new diff_match_patch();
    let textWithAuthors = [{ text: revisions[0].content, author: revisions[0].author }];
    
    for (let i = 1; i < revisions.length; i++) {
        const rev = revisions[i];
        const newContent = rev.content;
        const oldContent = revisions[i-1].content;
        
        const diffs = dmp.diff_main(oldContent, newContent);
        dmp.diff_cleanupSemantic(diffs);
        
        let newAttribution = [];
        let oldIdx = 0;
        
        diffs.forEach(([type, text]) => {
            if (type === 0) { // Unchanged
                let remaining = text.length;
                while (remaining > 0 && oldIdx < textWithAuthors.length) {
                    const segment = textWithAuthors[oldIdx];
                    if (segment.text.length <= remaining) {
                        newAttribution.push({ ...segment });
                        remaining -= segment.text.length;
                        oldIdx++;
                    } else {
                        newAttribution.push({ text: segment.text.substring(0, remaining), author: segment.author });
                        textWithAuthors[oldIdx].text = segment.text.substring(remaining);
                        remaining = 0;
                    }
                }
            } else if (type === 1) { // Added
                newAttribution.push({ text, author: rev.author });
            } else if (type === -1) { // Deleted
                let remaining = text.length;
                while (remaining > 0 && oldIdx < textWithAuthors.length) {
                    const segment = textWithAuthors[oldIdx];
                    if (segment.text.length <= remaining) {
                        remaining -= segment.text.length;
                        oldIdx++;
                    } else {
                        textWithAuthors[oldIdx].text = segment.text.substring(remaining);
                        remaining = 0;
                    }
                }
            }
        });
        textWithAuthors = newAttribution;
    }

    // Render HTML
    editor.innerHTML = '';
    legendItems.innerHTML = '';
    const authors = new Set();
    
    textWithAuthors.forEach(seg => {
        if (!seg.text) return;
        const span = document.createElement('span');
        span.className = 'author-highlight';
        const colors = getAuthorColor(seg.author);
        span.style.setProperty('--author-bg', colors.bg);
        span.style.setProperty('--author-color', colors.border);
        span.textContent = seg.text;
        span.title = `Written by ${seg.author}`;
        editor.appendChild(span);
        authors.add(seg.author);
    });
    
    authors.forEach(author => {
        const colors = getAuthorColor(author);
        const div = document.createElement('div');
        div.className = 'legend-item';
        div.innerHTML = `
            <div class="legend-swatch" style="background: ${colors.bg}; border: 1px solid ${colors.border}"></div>
            <span>${author}</span>
        `;
        legendItems.appendChild(div);
    });
  }

  function goBack() {
    editMode = false;
    document.getElementById('editorView').classList.add('hidden');
    document.getElementById('dashboardView').classList.remove('hidden');
    document.getElementById('draftText').contentEditable = false;
    document.getElementById('draftText').classList.remove('editing');
    currentTaskId = null;
    loadDashboard();
  }

  async function toggleEditMode() {
    const user = db.getCurrentUser();

    editMode = !editMode;
    
    // Disable highlights when editing for cleaner experience
    if (editMode && highlightsEnabled) {
      await toggleHighlights();
    }

    const editor = document.getElementById('draftText');
    editor.contentEditable = editMode;
    editor.classList.toggle('editing', editMode);
    document.getElementById('editBtn').classList.toggle('active', editMode);

    if (editMode) {
      editor.focus();
    }
  }

  async function saveRevision() {
    const content = document.getElementById('draftText').textContent;
    const user = db.getCurrentUser();

    await db.addRevision(currentTaskId, content, user.name);

    editMode = false;
    document.getElementById('draftText').contentEditable = false;
    document.getElementById('draftText').classList.remove('editing');
    document.getElementById('editBtn').classList.remove('active');

    const revisions = await db.getTaskRevisions(currentTaskId);
    document.getElementById('revisionLabel').textContent = `Revision ${revisions.length} by ${user.name}`;

    await loadRevisions(currentTaskId);
    await renderDraftContent(currentTaskId);
    alert('Revision saved!');
  }

  function loadChecklistItems(checklist) {
    const listEl = document.getElementById('checklistItems');
    listEl.innerHTML = '';
    const user = db.getCurrentUser();
    
    checklist.forEach((item, idx) => {
      const li = document.createElement('li');
      const text = typeof item === 'string' ? item : item.text;
      const checked = typeof item === 'object' ? item.checked : (item.checked || false);
      
      const isTeacher = user.role === 'teacher';
      const isDisabled = !isTeacher ? 'disabled' : '';
      const checkedAttr = checked ? 'checked' : '';
      
      li.innerHTML = `
        <input type="checkbox" id="check-${idx}" ${isDisabled} ${checkedAttr} onchange="toggleChecklistItem(${idx}, this.checked)">
        <label for="check-${idx}" style="${!isTeacher ? 'cursor: default;' : ''}">${text}</label>
      `;
      listEl.appendChild(li);
    });
    
    if (user.role !== 'teacher') {
      const helper = document.createElement('div');
      helper.className = 'helper-text';
      helper.style.marginTop = '10px';
      helper.style.fontSize = '11px';
      helper.innerHTML = '🔒 Only teachers can check feedback items.';
      listEl.appendChild(helper);
    }
  }

  async function toggleChecklistItem(idx, checked) {
    const studentId = document.getElementById('studentSelector').value;
    const studentName = document.getElementById('studentSelector').options[document.getElementById('studentSelector').selectedIndex].text;
    
    if (!studentId) return;

    // Get current checklist UI state
    const items = [];
    document.querySelectorAll('#checklistItems input').forEach((cb, i) => {
        items.push({
            text: cb.nextElementSibling.textContent,
            checked: i === idx ? checked : cb.checked
        });
    });

    await db.updateStudentChecklist(currentTaskId, studentId, studentName, items);
  }

  async function loadComments(taskId) {
    const commentsList = document.getElementById('commentsList');
    const taskComments = await db.getTaskComments(taskId);
    const user = db.getCurrentUser();
    commentsList.innerHTML = '';

    taskComments.forEach(comment => {
      // Privacy filter: students only see their own comments. Teachers see everything.
      if (user.role === 'teacher' || comment.author === user.name) {
        const div = document.createElement('div');
        div.className = 'comment';
        div.innerHTML = `
          <div class="comment-author">${comment.author} ${comment.author === user.name ? '(You)' : ''}</div>
          <div class="comment-time">${new Date(comment.timestamp).toLocaleString()}</div>
          <div class="comment-text">${comment.text}</div>
        `;
        commentsList.appendChild(div);
      }
    });

    if (commentsList.innerHTML === '' && user.role !== 'teacher') {
        commentsList.innerHTML = '<div style="text-align:center; color:#999; padding:20px; font-size:13px;">No private comments yet. Share your thoughts with the teacher!</div>';
    }
  }

  async function addComment() {
    const text = document.getElementById('newCommentText').value.trim();
    if (!text) {
      alert('Please write a comment');
      return;
    }

    const user = db.getCurrentUser();
    await db.addComment(currentTaskId, user.name, text);
    document.getElementById('newCommentText').value = '';
    await loadComments(currentTaskId);
  }

  async function loadRevisions(taskId) {
    const revisionsList = document.getElementById('revisionsList');
    const revisions = await db.getTaskRevisions(taskId);
    revisionsList.innerHTML = '';

    revisions.forEach((rev, idx) => {
      const div = document.createElement('div');
      div.className = 'revision-item';
      if (idx === revisions.length - 1) div.classList.add('active');
      div.innerHTML = `
        <div class="revision-author">Rev ${idx + 1}</div>
        <div class="revision-time">${new Date(rev.timestamp).toLocaleString()}</div>
        <div style="color: #666; margin-top: 4px; font-size: 11px;">by ${rev.author}</div>
      `;
      div.onclick = () => {
        document.getElementById('draftText').textContent = rev.content;
        document.getElementById('draftText').contentEditable = false;
        editMode = false;
        document.getElementById('editBtn').classList.remove('active');
        document.querySelectorAll('.revision-item').forEach(item => item.classList.remove('active'));
        div.classList.add('active');

        // Disable highlights when viewing history
        if (highlightsEnabled) {
          highlightsEnabled = false;
          const btn = document.getElementById('highlightBtn');
          btn.classList.remove('active');
          btn.textContent = '🏷️ Show Authors';
          document.getElementById('authorLegend').classList.add('hidden');
          document.getElementById('draftText').classList.remove('show-highlights');
        }
      };
      revisionsList.appendChild(div);
    });
  }

  function openCreateTaskModal() {
    document.getElementById('createTaskModal').classList.add('active');
  }

  function closeCreateTaskModal() {
    document.getElementById('createTaskModal').classList.remove('active');
    document.getElementById('newTaskTitle').value = '';
    document.getElementById('newTaskInstructions').value = '';
    document.getElementById('newTaskChecklist').value = '';
  }

  async function createTask() {
    const title = document.getElementById('newTaskTitle').value.trim();
    const instructions = document.getElementById('newTaskInstructions').value.trim();
    const checklist = document.getElementById('newTaskChecklist').value.trim();

    if (!title || !instructions || !checklist) {
      alert('Please fill in all fields');
      return;
    }

    const user = db.getCurrentUser();
    await db.createTask(title, instructions, checklist, user.name);

    closeCreateTaskModal();
    await loadDashboard();
    alert('Task created!');
  }

  async function promptRenameStudent(studentId, currentName) {
    const newName = prompt('Enter new display name for student:', currentName);
    if (newName && newName.trim() && newName !== currentName) {
        await db.renameProfile(studentId, newName.trim());
        await loadStudentsView(); // Refresh the list
    }
  }

  async function promptRename() {
    const task = await db.getTask(currentTaskId);
    const newTitle = prompt('Enter new task title:', task.title);
    if (newTitle && newTitle.trim() && newTitle !== task.title) {
        await db.renameTask(currentTaskId, newTitle.trim());
        document.getElementById('taskTitle').textContent = newTitle.trim();
        await loadDashboard(); // Update sidebar/dashboard titles
    }
  }

  async function confirmDelete() {
    if (confirm('Are you sure you want to PERMANENTLY delete this task? This cannot be undone.')) {
        await db.deleteTask(currentTaskId);
        goBack(); // Return to dashboard
    }
  }
