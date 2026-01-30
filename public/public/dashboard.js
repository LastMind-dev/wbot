// ========================================
// Global State
// ========================================
let instances = [];
let groups = [];
let users = [];
let testHistory = [];
let messageHistory = [];
let currentInstance = '';

// ========================================
// Initialize
// ========================================
document.addEventListener('DOMContentLoaded', () => {
    initializeDashboard();
    setupNavigation();
    loadLocalData();
    setupTestingEvents();
});

function setupTestingEvents() {
    const testingInstanceSelect = document.getElementById('testing-instance-select');
    if (testingInstanceSelect) {
        testingInstanceSelect.addEventListener('change', updateTestingConnectionStatus);
    }
}

async function initializeDashboard() {
    await loadInstances();
    await loadSystemHealth();
    updatePreviewTime();
    setInterval(updatePreviewTime, 60000);
}

function setupNavigation() {
    document.querySelectorAll('.sidebar-nav a[data-section]').forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const section = link.getAttribute('data-section');
            showSection(section);
        });
    });
}

function showSection(sectionName) {
    document.querySelectorAll('.page-section').forEach(section => {
        section.classList.remove('active');
    });
    document.querySelectorAll('.sidebar-nav a').forEach(link => {
        link.classList.remove('active');
    });

    const targetSection = document.getElementById(`section-${sectionName}`);
    if (targetSection) {
        targetSection.classList.add('active');
    }

    const targetLink = document.querySelector(`.sidebar-nav a[data-section="${sectionName}"]`);
    if (targetLink) {
        targetLink.classList.add('active');
    }

    if (sectionName === 'groups') {
        populateInstanceSelects();
        // Force load groups if instance is selected
        const groupsSelect = document.getElementById('groups-instance-select');
        if (groupsSelect && groupsSelect.value) {
            loadGroups();
        }
    } else if (sectionName === 'testing') {
        populateInstanceSelects();
        updateTestingConnectionStatus();
    } else if (sectionName === 'users') {
        loadUsers();
    }
}

function toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('open');
}

// ========================================
// Local Storage
// ========================================
function loadLocalData() {
    const savedUsers = localStorage.getItem('wbot_users');
    if (savedUsers) {
        users = JSON.parse(savedUsers);
        renderUsersTable();
    }

    const savedHistory = localStorage.getItem('wbot_test_history');
    if (savedHistory) {
        testHistory = JSON.parse(savedHistory);
        renderTestHistory();
    }

    const savedMessageHistory = localStorage.getItem('wbot_message_history');
    if (savedMessageHistory) {
        messageHistory = JSON.parse(savedMessageHistory);
    }
}

function saveLocalData() {
    localStorage.setItem('wbot_users', JSON.stringify(users));
    localStorage.setItem('wbot_test_history', JSON.stringify(testHistory));
    localStorage.setItem('wbot_message_history', JSON.stringify(messageHistory));
}

// ========================================
// API Calls
// ========================================
async function loadInstances() {
    try {
        // First try to load from database API (persistent)
        const res = await fetch('/api/instances');
        const data = await res.json();

        if (data.success && data.instances) {
            instances = data.instances;
            renderInstancesTable();
            renderFullInstancesTable();
            populateInstanceSelects();
            updateStats();
        } else {
            // Fallback to health API (in-memory only)
            const healthRes = await fetch('/api/health');
            const healthData = await healthRes.json();
            if (healthData.sessions && healthData.sessions.list) {
                instances = healthData.sessions.list;
                renderInstancesTable();
                renderFullInstancesTable();
                populateInstanceSelects();
                updateStats();
            }
        }
    } catch (err) {
        showNotification('Erro ao carregar instâncias: ' + err.message, 'error');
    }
}

async function loadSystemHealth() {
    try {
        const res = await fetch('/api/health');
        const data = await res.json();

        if (data.memory) {
            document.getElementById('info-memory').textContent = formatBytes(data.memory.heapUsed);
        }
        if (data.uptime) {
            document.getElementById('info-uptime').textContent = formatUptime(data.uptime);
        }
        if (data.sessions) {
            document.getElementById('info-sessions').textContent = data.sessions.active + '/' + data.sessions.total;
        }
    } catch (err) {
        console.error('Health check error:', err);
    }
}

async function loadGroups() {
    const instanceId = document.getElementById('groups-instance-select').value;
    if (!instanceId) {
        document.getElementById('groups-list').innerHTML = '<div class="empty-state"><span uk-icon="icon: users; ratio: 3"></span><p>Selecione uma instância para ver os grupos</p></div>';
        return;
    }

    currentInstance = instanceId;
    document.getElementById('groups-list').innerHTML = '<div class="uk-text-center uk-padding"><div uk-spinner></div><p>Carregando grupos...</p></div>';

    try {
        const res = await fetch(`/api/group/list/${instanceId}`);
        const data = await res.json();

        if (data.success) {
            groups = data.groups;
            document.getElementById('groups-count').textContent = data.count;
            document.getElementById('stat-groups').textContent = data.count;
            renderGroupsList();
            populateGroupSelect();
        } else {
            document.getElementById('groups-list').innerHTML = `<div class="uk-alert-danger" uk-alert>${data.error}</div>`;
        }
    } catch (err) {
        document.getElementById('groups-list').innerHTML = `<div class="uk-alert-danger" uk-alert>${err.message}</div>`;
    }
}

// ========================================
// Render Functions
// ========================================
function renderInstancesTable() {
    const tbody = document.getElementById('instances-table-body');

    if (instances.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="uk-text-center uk-text-muted">Nenhuma instância encontrada</td></tr>';
        return;
    }

    tbody.innerHTML = instances.slice(0, 5).map(inst => {
                const statusClass = getStatusClass(inst.status);
                return `
            <tr>
                <td><strong>${escapeHtml(inst.name || inst.id.substring(0, 8))}</strong></td>
                <td>${inst.phone || '---'}</td>
                <td><span class="status-badge ${statusClass}">${inst.status}</span></td>
                <td>${inst.lastConnection ? new Date(inst.lastConnection).toLocaleString() : '---'}</td>
                <td class="uk-text-right">
                    ${inst.status === 'QR_CODE' ? `<button class="uk-button uk-button-small uk-button-default" onclick="showQrCode('${inst.id}')"><span uk-icon="icon: camera"></span></button>` : ''}
                    ${inst.status === 'DISCONNECTED' ? `<button class="uk-button uk-button-small uk-button-primary" onclick="startSession('${inst.id}')"><span uk-icon="icon: play"></span></button>` : ''}
                    ${inst.status === 'CONNECTED' ? `<button class="uk-button uk-button-small uk-button-danger" onclick="stopSession('${inst.id}')"><span uk-icon="icon: ban"></span></button>` : ''}
                </td>
            </tr>
        `;
    }).join('');
}

function renderFullInstancesTable() {
    const tbody = document.getElementById('full-instances-table');
    
    if (instances.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="uk-text-center uk-text-muted">Nenhuma instância encontrada</td></tr>';
        return;
    }
    
    tbody.innerHTML = instances.map(inst => {
        const statusClass = getStatusClass(inst.status);
        return `
            <tr>
                <td><strong>${escapeHtml(inst.name || 'Sem nome')}</strong></td>
                <td><code style="font-size: 0.75rem;">${inst.id.substring(0, 12)}...</code></td>
                <td>${inst.phone || '---'}</td>
                <td style="max-width: 200px; overflow: hidden; text-overflow: ellipsis;">${inst.phpUrl || '---'}</td>
                <td><span class="status-badge ${statusClass}">${inst.status}</span></td>
                <td class="uk-text-right">
                    <button class="uk-button uk-button-small uk-button-secondary action-btn" onclick="showInstanceInfo('${inst.id}')" title="Informações API"><span uk-icon="icon: info; ratio: 0.8"></span></button>
                    ${inst.status === 'QR_CODE' ? `<button class="uk-button uk-button-small uk-button-default action-btn" onclick="showQrCode('${inst.id}')" title="Ver QR Code"><span uk-icon="icon: camera; ratio: 0.8"></span></button>` : ''}
                    ${inst.status === 'DISCONNECTED' || inst.status === 'AUTH_FAILURE' ? `<button class="uk-button uk-button-small uk-button-primary action-btn" onclick="startSession('${inst.id}')" title="Iniciar"><span uk-icon="icon: play; ratio: 0.8"></span></button>` : ''}
                    ${inst.status === 'CONNECTED' || inst.status === 'INITIALIZING' ? `<button class="uk-button uk-button-small uk-button-warning action-btn" onclick="stopSession('${inst.id}')" title="Parar"><span uk-icon="icon: ban; ratio: 0.8"></span></button>` : ''}
                    <button class="uk-button uk-button-small uk-button-default action-btn" onclick="reconnectSession('${inst.id}')" title="Reconectar"><span uk-icon="icon: refresh; ratio: 0.8"></span></button>
                    <button class="uk-button uk-button-small uk-button-danger action-btn" onclick="deleteInstance('${inst.id}', '${escapeHtml(inst.name || inst.id)}')" title="Deletar"><span uk-icon="icon: trash; ratio: 0.8"></span></button>
                </td>
            </tr>
        `;
    }).join('');
}

function renderGroupsList() {
    const container = document.getElementById('groups-list');
    
    if (groups.length === 0) {
        container.innerHTML = '<div class="empty-state"><span uk-icon="icon: users; ratio: 2"></span><p>Nenhum grupo encontrado</p></div>';
        return;
    }
    
    container.innerHTML = groups.map(g => `
        <div class="group-item" onclick="selectGroup('${g.id}', '${escapeHtml(g.name)}')">
            <div class="group-item-info">
                <h4>${escapeHtml(g.name)}</h4>
                <small>${g.participantsCount || 0} participantes</small>
            </div>
            <div class="group-item-actions">
                <button class="uk-button uk-button-small uk-button-default" onclick="event.stopPropagation(); viewGroupInfo('${g.id}')" title="Ver detalhes"><span uk-icon="icon: info; ratio: 0.8"></span></button>
                <button class="uk-button uk-button-small uk-button-primary" onclick="event.stopPropagation(); openAddParticipantsModal('${g.id}', '${escapeHtml(g.name)}')" title="Adicionar membros"><span uk-icon="icon: plus; ratio: 0.8"></span></button>
                <button class="uk-button uk-button-small uk-button-default" onclick="event.stopPropagation(); getInviteLink('${g.id}')" title="Link de convite"><span uk-icon="icon: link; ratio: 0.8"></span></button>
            </div>
        </div>
    `).join('');
}

function renderUsersTable() {
    const tbody = document.getElementById('users-table-body');
    
    if (users.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="uk-text-center uk-text-muted"><div class="empty-state"><span uk-icon="icon: users; ratio: 2"></span><p>Nenhum usuário cadastrado</p></div></td></tr>';
        return;
    }
    
    tbody.innerHTML = users.map((user, index) => `
        <tr>
            <td><input class="uk-checkbox user-checkbox" type="checkbox" data-index="${index}"></td>
            <td>
                <div class="uk-flex uk-flex-middle">
                    <div class="user-avatar uk-margin-small-right">${getInitials(user.name)}</div>
                    <div>
                        <strong>${escapeHtml(user.name)}</strong>
                        ${user.email ? `<br><small class="uk-text-muted">${escapeHtml(user.email)}</small>` : ''}
                    </div>
                </div>
            </td>
            <td><code>${escapeHtml(user.number)}</code></td>
            <td>${user.group ? `<span class="badge badge-info">${escapeHtml(user.group)}</span>` : '<span class="uk-text-muted">-</span>'}</td>
            <td><span class="badge ${user.status === 'active' ? 'badge-success' : 'badge-warning'}">${user.status === 'active' ? 'Ativo' : 'Inativo'}</span></td>
            <td>${user.createdAt ? new Date(user.createdAt).toLocaleDateString() : '---'}</td>
            <td class="uk-text-right">
                <button class="uk-button uk-button-small uk-button-default action-btn" onclick="editUser(${index})" title="Editar"><span uk-icon="icon: pencil; ratio: 0.8"></span></button>
                <button class="uk-button uk-button-small uk-button-danger action-btn" onclick="deleteUser(${index})" title="Deletar"><span uk-icon="icon: trash; ratio: 0.8"></span></button>
            </td>
        </tr>
    `).join('');
}

function renderTestHistory() {
    const container = document.getElementById('test-history-list');
    
    if (testHistory.length === 0) {
        container.innerHTML = '<div class="empty-state"><span uk-icon="icon: clock; ratio: 2"></span><p>Nenhum teste realizado</p></div>';
        return;
    }
    
    container.innerHTML = testHistory.slice(0, 10).map(item => `
        <div class="history-item">
            <div class="history-icon ${item.success ? 'sent' : 'error'}">
                <span uk-icon="icon: ${item.success ? 'check' : 'close'}"></span>
            </div>
            <div class="history-content">
                <h5>${item.success ? 'Enviado' : 'Erro'} - ${escapeHtml(item.to)}</h5>
                <p>${escapeHtml(item.message.substring(0, 50))}${item.message.length > 50 ? '...' : ''}</p>
            </div>
            <span class="history-time">${formatTime(item.timestamp)}</span>
        </div>
    `).join('');
}

// ========================================
// Instance Actions
// ========================================
async function createInstance(event) {
    event.preventDefault();
    
    const name = document.getElementById('new-instance-name').value.trim();
    const phpUrl = document.getElementById('new-instance-php-url').value.trim();
    const webhook = document.getElementById('new-instance-webhook').value.trim();
    
    try {
        const res = await fetch('/api/instance/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name,
                sistema_php_url: phpUrl,
                webhook: webhook || null
            })
        });
        
        const data = await res.json();
        
        if (data.success) {
            showNotification('Instância criada com sucesso!', 'success');
            UIkit.modal('#modal-new-instance').hide();
            document.getElementById('form-new-instance').reset();
            await loadInstances();
        } else {
            showNotification('Erro: ' + data.error, 'error');
        }
    } catch (err) {
        showNotification('Erro: ' + err.message, 'error');
    }
}

async function startSession(instanceId) {
    try {
        const res = await fetch('/api/session/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ instanceId })
        });
        const data = await res.json();
        showNotification(data.message || 'Sessão iniciada', 'success');
        setTimeout(() => loadInstances(), 2000);
    } catch (err) {
        showNotification('Erro: ' + err.message, 'error');
    }
}

async function stopSession(instanceId) {
    try {
        const res = await fetch('/api/session/stop', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ instanceId })
        });
        const data = await res.json();
        showNotification(data.message || 'Sessão parada', 'success');
        await loadInstances();
    } catch (err) {
        showNotification('Erro: ' + err.message, 'error');
    }
}

async function reconnectSession(instanceId) {
    if (!confirm('Deseja forçar reconexão desta instância?')) return;
    
    try {
        const res = await fetch('/api/session/reconnect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ instanceId })
        });
        const data = await res.json();
        showNotification(data.message || 'Reconectando...', 'info');
        setTimeout(() => loadInstances(), 3000);
    } catch (err) {
        showNotification('Erro: ' + err.message, 'error');
    }
}

async function deleteInstance(instanceId, name) {
    if (!confirm(`⚠️ ATENÇÃO: Você está prestes a DELETAR permanentemente a instância "${name}".\n\nEsta ação NÃO pode ser desfeita!\n\nDeseja continuar?`)) {
        return;
    }
    
    try {
        const res = await fetch(`/api/instance/${instanceId}`, { method: 'DELETE' });
        const data = await res.json();
        
        if (data.success) {
            showNotification('Instância deletada com sucesso!', 'success');
            await loadInstances();
        } else {
            showNotification('Erro: ' + data.error, 'error');
        }
    } catch (err) {
        showNotification('Erro: ' + err.message, 'error');
    }
}

function showQrCode(instanceId) {
    document.getElementById('qr-code-container').innerHTML = `<img src="/api/session/qr/${instanceId}" style="max-width: 280px; border-radius: 10px;">`;
    UIkit.modal('#modal-qr-code').show();
}

// ========================================
// Group Actions
// ========================================
function selectGroup(groupId, groupName) {
    document.getElementById('selected-group-id').value = groupId;
    document.getElementById('selected-group-name').value = groupName;
    viewGroupInfo(groupId);
}

async function viewGroupInfo(groupId) {
    const container = document.getElementById('group-details');
    container.innerHTML = '<div class="uk-text-center uk-padding"><div uk-spinner></div></div>';
    
    try {
        const res = await fetch(`/api/group/info/${currentInstance}/${encodeURIComponent(groupId)}`);
        const data = await res.json();
        
        if (data.success) {
            const g = data.group;
            container.innerHTML = `
                <h4>${escapeHtml(g.name)}</h4>
                <p><strong>ID:</strong> <code style="font-size: 0.75rem;">${g.id}</code></p>
                <p><strong>Descrição:</strong> ${escapeHtml(g.description || 'Sem descrição')}</p>
                <p><strong>Criado em:</strong> ${g.createdAt ? new Date(g.createdAt * 1000).toLocaleString() : 'N/A'}</p>
                <p><strong>Participantes:</strong> ${g.participants?.length || 0}</p>
                
                <div class="member-list">
                    ${(g.participants || []).map(p => `
                        <div class="member-item">
                            <span>${p.id.replace('@c.us', '')}</span>
                            <div>
                                ${p.isAdmin ? '<span class="badge badge-success">Admin</span>' : ''}
                                ${p.isSuperAdmin ? '<span class="badge badge-info">Super Admin</span>' : ''}
                            </div>
                        </div>
                    `).join('')}
                </div>
            `;
        } else {
            container.innerHTML = `<div class="uk-alert-danger" uk-alert>${data.error}</div>`;
        }
    } catch (err) {
        container.innerHTML = `<div class="uk-alert-danger" uk-alert>${err.message}</div>`;
    }
}

async function createGroup(event) {
    event.preventDefault();
    
    const instanceId = document.getElementById('groups-instance-select').value;
    if (!instanceId) {
        showNotification('Selecione uma instância primeiro', 'error');
        return;
    }
    
    const name = document.getElementById('new-group-name').value.trim();
    const description = document.getElementById('new-group-description').value.trim();
    const participantsText = document.getElementById('new-group-participants').value.trim();
    
    const participants = participantsText.split('\n').map(p => p.trim()).filter(p => p.length > 0);
    
    try {
        const res = await fetch('/api/group/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                instance: instanceId,
                name,
                description,
                participants
            })
        });
        
        const data = await res.json();
        
        if (data.success) {
            showNotification('Grupo criado com sucesso!', 'success');
            UIkit.modal('#modal-new-group').hide();
            document.getElementById('form-new-group').reset();
            loadGroups();
        } else {
            showNotification('Erro: ' + data.error, 'error');
        }
    } catch (err) {
        showNotification('Erro: ' + err.message, 'error');
    }
}

function openAddParticipantsModal(groupId, groupName) {
    document.getElementById('add-participants-group-id').value = groupId;
    document.getElementById('add-participants-group-name').value = groupName;
    UIkit.modal('#modal-add-participants').show();
}

async function addParticipants(event) {
    event.preventDefault();
    
    const groupId = document.getElementById('add-participants-group-id').value;
    const participantsText = document.getElementById('add-participants-numbers').value.trim();
    
    const participants = participantsText.split('\n').map(p => p.trim()).filter(p => p.length > 0);
    
    if (participants.length === 0) {
        showNotification('Adicione pelo menos um número', 'error');
        return;
    }
    
    try {
        const res = await fetch('/api/group/add-participants', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                instance: currentInstance,
                groupId,
                participants
            })
        });
        
        const data = await res.json();
        
        if (data.success) {
            showNotification('Participantes processados!', 'success');
            UIkit.modal('#modal-add-participants').hide();
            document.getElementById('add-participants-numbers').value = '';
            viewGroupInfo(groupId);
        } else {
            showNotification('Erro: ' + data.error, 'error');
        }
    } catch (err) {
        showNotification('Erro: ' + err.message, 'error');
    }
}

async function sendGroupMessage() {
    const groupId = document.getElementById('selected-group-id').value;
    const message = document.getElementById('group-message-text').value.trim();
    
    if (!groupId) {
        showNotification('Selecione um grupo primeiro', 'error');
        return;
    }
    
    if (!message) {
        showNotification('Digite uma mensagem', 'error');
        return;
    }
    
    try {
        const res = await fetch('/api/group/send-message', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                instance: currentInstance,
                groupId,
                message
            })
        });
        
        const data = await res.json();
        
        if (data.success) {
            showNotification('Mensagem enviada com sucesso!', 'success');
            document.getElementById('group-message-text').value = '';
            addToMessageHistory(groupId, message, true);
        } else {
            showNotification('Erro: ' + data.error, 'error');
        }
    } catch (err) {
        showNotification('Erro: ' + err.message, 'error');
    }
}

async function getInviteLink(groupId) {
    try {
        const res = await fetch(`/api/group/invite-link/${currentInstance}/${encodeURIComponent(groupId)}`);
        const data = await res.json();
        
        if (data.success) {
            navigator.clipboard.writeText(data.inviteLink).then(() => {
                showNotification('Link copiado para a área de transferência!', 'success');
            }).catch(() => {
                prompt('Link de convite:', data.inviteLink);
            });
        } else {
            showNotification('Erro: ' + data.error, 'error');
        }
    } catch (err) {
        showNotification('Erro: ' + err.message, 'error');
    }
}

// ========================================
// User Management
// ========================================
function loadUsers() {
    renderUsersTable();
    populateUserGroupFilters();
}

function createUser(event) {
    event.preventDefault();
    
    const user = {
        id: Date.now(),
        name: document.getElementById('new-user-name').value.trim(),
        number: document.getElementById('new-user-number').value.trim(),
        email: document.getElementById('new-user-email').value.trim(),
        group: document.getElementById('new-user-group').value,
        notes: document.getElementById('new-user-notes').value.trim(),
        status: 'active',
        createdAt: new Date().toISOString()
    };
    
    users.push(user);
    saveLocalData();
    renderUsersTable();
    
    showNotification('Usuário adicionado com sucesso!', 'success');
    UIkit.modal('#modal-new-user').hide();
    document.getElementById('form-new-user').reset();
}

function editUser(index) {
    const user = users[index];
    
    document.getElementById('edit-user-id').value = index;
    document.getElementById('edit-user-name').value = user.name;
    document.getElementById('edit-user-number').value = user.number;
    document.getElementById('edit-user-email').value = user.email || '';
    document.getElementById('edit-user-group').value = user.group || '';
    document.getElementById('edit-user-notes').value = user.notes || '';
    document.getElementById('edit-user-status').value = user.status || 'active';
    
    UIkit.modal('#modal-edit-user').show();
}

function updateUser(event) {
    event.preventDefault();
    
    const index = parseInt(document.getElementById('edit-user-id').value);
    
    users[index] = {
        ...users[index],
        name: document.getElementById('edit-user-name').value.trim(),
        number: document.getElementById('edit-user-number').value.trim(),
        email: document.getElementById('edit-user-email').value.trim(),
        group: document.getElementById('edit-user-group').value,
        notes: document.getElementById('edit-user-notes').value.trim(),
        status: document.getElementById('edit-user-status').value
    };
    
    saveLocalData();
    renderUsersTable();
    
    showNotification('Usuário atualizado com sucesso!', 'success');
    UIkit.modal('#modal-edit-user').hide();
}

function deleteUser(index) {
    if (!confirm('Tem certeza que deseja excluir este usuário?')) return;
    
    users.splice(index, 1);
    saveLocalData();
    renderUsersTable();
    showNotification('Usuário removido', 'success');
}

function filterUsers() {
    const search = document.getElementById('users-search').value.toLowerCase();
    const groupFilter = document.getElementById('users-filter-group').value;
    
    const filtered = users.filter(user => {
        const matchesSearch = user.name.toLowerCase().includes(search) || 
                             user.number.includes(search) ||
                             (user.email && user.email.toLowerCase().includes(search));
        const matchesGroup = !groupFilter || user.group === groupFilter;
        return matchesSearch && matchesGroup;
    });
    
    renderFilteredUsers(filtered);
}

function renderFilteredUsers(filteredUsers) {
    const tbody = document.getElementById('users-table-body');
    
    if (filteredUsers.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="uk-text-center uk-text-muted">Nenhum usuário encontrado</td></tr>';
        return;
    }
    
    tbody.innerHTML = filteredUsers.map((user, index) => {
        const originalIndex = users.indexOf(user);
        return `
            <tr>
                <td><input class="uk-checkbox user-checkbox" type="checkbox" data-index="${originalIndex}"></td>
                <td>
                    <div class="uk-flex uk-flex-middle">
                        <div class="user-avatar uk-margin-small-right">${getInitials(user.name)}</div>
                        <div>
                            <strong>${escapeHtml(user.name)}</strong>
                            ${user.email ? `<br><small class="uk-text-muted">${escapeHtml(user.email)}</small>` : ''}
                        </div>
                    </div>
                </td>
                <td><code>${escapeHtml(user.number)}</code></td>
                <td>${user.group ? `<span class="badge badge-info">${escapeHtml(user.group)}</span>` : '<span class="uk-text-muted">-</span>'}</td>
                <td><span class="badge ${user.status === 'active' ? 'badge-success' : 'badge-warning'}">${user.status === 'active' ? 'Ativo' : 'Inativo'}</span></td>
                <td>${user.createdAt ? new Date(user.createdAt).toLocaleDateString() : '---'}</td>
                <td class="uk-text-right">
                    <button class="uk-button uk-button-small uk-button-default action-btn" onclick="editUser(${originalIndex})" title="Editar"><span uk-icon="icon: pencil; ratio: 0.8"></span></button>
                    <button class="uk-button uk-button-small uk-button-danger action-btn" onclick="deleteUser(${originalIndex})" title="Deletar"><span uk-icon="icon: trash; ratio: 0.8"></span></button>
                </td>
            </tr>
        `;
    }).join('');
}

function toggleSelectAllUsers() {
    const selectAll = document.getElementById('select-all-users').checked;
    document.querySelectorAll('.user-checkbox').forEach(cb => cb.checked = selectAll);
}

function exportUsers() {
    if (users.length === 0) {
        showNotification('Nenhum usuário para exportar', 'warning');
        return;
    }
    
    const csv = 'Nome,Número,Email,Grupo,Status,Criado em\n' + 
        users.map(u => `"${u.name}","${u.number}","${u.email || ''}","${u.group || ''}","${u.status}","${u.createdAt || ''}"`).join('\n');
    
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'usuarios_whatsapp.csv';
    a.click();
    URL.revokeObjectURL(url);
    
    showNotification('Exportação concluída!', 'success');
}

function importUsers(event) {
    event.preventDefault();
    
    const listText = document.getElementById('import-users-list').value.trim();
    const group = document.getElementById('import-users-group').value;
    
    if (!listText) {
        showNotification('Insira os números para importar', 'error');
        return;
    }
    
    const numbers = listText.split('\n').map(n => n.trim()).filter(n => n.length > 0);
    
    let imported = 0;
    numbers.forEach(number => {
        if (!users.find(u => u.number === number)) {
            users.push({
                id: Date.now() + imported,
                name: 'Usuário ' + number.slice(-4),
                number: number,
                email: '',
                group: group,
                notes: '',
                status: 'active',
                createdAt: new Date().toISOString()
            });
            imported++;
        }
    });
    
    saveLocalData();
    renderUsersTable();
    
    showNotification(`${imported} usuários importados com sucesso!`, 'success');
    UIkit.modal('#modal-import-users').hide();
    document.getElementById('form-import-users').reset();
}

// ========================================
// Testing Functions
// ========================================
function toggleRecipientInput() {
    const type = document.getElementById('test-recipient-type').value;
    document.getElementById('individual-recipient-div').classList.toggle('uk-hidden', type === 'group');
    document.getElementById('group-recipient-div').classList.toggle('uk-hidden', type === 'individual');
}

function updatePreview() {
    const message = document.getElementById('test-message').value;
    document.getElementById('preview-text').textContent = message || 'Digite uma mensagem para ver o preview...';
}

function updatePreviewTime() {
    const now = new Date();
    document.getElementById('preview-time').textContent = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

async function sendTestMessage() {
    const instanceId = document.getElementById('testing-instance-select').value;
    const recipientType = document.getElementById('test-recipient-type').value;
    const message = document.getElementById('test-message').value.trim();
    const simulateOnly = document.getElementById('test-simulate-only').checked;
    
    let recipient;
    if (recipientType === 'individual') {
        recipient = document.getElementById('test-recipient').value.trim();
    } else {
        recipient = document.getElementById('test-recipient-group').value;
    }
    
    if (!instanceId) {
        showNotification('Selecione uma instância', 'error');
        return;
    }
    
    if (!recipient) {
        showNotification('Informe o destinatário', 'error');
        return;
    }
    
    if (!message) {
        showNotification('Digite uma mensagem', 'error');
        return;
    }
    
    if (simulateOnly) {
        addTestToHistory(recipient, message, true, 'Simulação');
        showNotification('Simulação realizada com sucesso!', 'success');
        return;
    }
    
    try {
        let res;
        if (recipientType === 'group') {
            res = await fetch('/api/group/send-message', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    instance: instanceId,
                    groupId: recipient,
                    message
                })
            });
        } else {
            res = await fetch('/api/send-text', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    instance: instanceId,
                    to: recipient,
                    message
                })
            });
        }
        
        const data = await res.json();
        
        // Check for success (different APIs return different formats)
        const isSuccess = data.success || (data.message && data.message.sent) || data.messageId;
        
        if (isSuccess) {
            addTestToHistory(recipient, message, true);
            showNotification('Mensagem enviada com sucesso!', 'success');
            document.getElementById('test-message').value = '';
            updatePreview();
        } else {
            const errorMsg = data.error || 'Erro desconhecido';
            addTestToHistory(recipient, message, false, errorMsg);
            showNotification('Erro: ' + errorMsg, 'error');
        }
    } catch (err) {
        addTestToHistory(recipient, message, false, err.message);
        showNotification('Erro: ' + err.message, 'error');
    }
}

async function sendTestMedia() {
    const instanceId = document.getElementById('testing-instance-select').value;
    const recipient = document.getElementById('test-media-recipient').value.trim();
    const mediaUrl = document.getElementById('test-media-url').value.trim();
    const caption = document.getElementById('test-media-caption').value.trim();
    
    if (!instanceId || !recipient || !mediaUrl) {
        showNotification('Preencha todos os campos obrigatórios', 'error');
        return;
    }
    
    try {
        const res = await fetch('/api/send-media', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                instance: instanceId,
                to: recipient,
                mediaUrl,
                caption
            })
        });
        
        const data = await res.json();
        
        if (data.success) {
            addTestToHistory(recipient, `[Mídia] ${caption || mediaUrl}`, true);
            showNotification('Mídia enviada com sucesso!', 'success');
        } else {
            addTestToHistory(recipient, `[Mídia] ${caption || mediaUrl}`, false, data.error);
            showNotification('Erro: ' + data.error, 'error');
        }
    } catch (err) {
        showNotification('Erro: ' + err.message, 'error');
    }
}

function addTestToHistory(to, message, success, error = null) {
    testHistory.unshift({
        to,
        message,
        success,
        error,
        timestamp: new Date().toISOString()
    });
    
    if (testHistory.length > 50) {
        testHistory = testHistory.slice(0, 50);
    }
    
    saveLocalData();
    renderTestHistory();
}

function clearTestHistory() {
    if (!confirm('Limpar todo o histórico de testes?')) return;
    testHistory = [];
    saveLocalData();
    renderTestHistory();
    showNotification('Histórico limpo', 'success');
}

// ========================================
// Settings & System
// ========================================
function saveGeneralSettings() {
    const settings = {
        phpUrl: document.getElementById('setting-php-url').value,
        webhook: document.getElementById('setting-webhook').value,
        autoReconnect: document.getElementById('setting-auto-reconnect').checked,
        logMessages: document.getElementById('setting-log-messages').checked
    };
    
    localStorage.setItem('wbot_settings', JSON.stringify(settings));
    showNotification('Configurações salvas!', 'success');
}

async function forceHealthCheck() {
    try {
        const res = await fetch('/api/health/check', { method: 'POST' });
        const data = await res.json();
        showNotification(data.message || 'Health check executado', 'success');
        await loadSystemHealth();
    } catch (err) {
        showNotification('Erro: ' + err.message, 'error');
    }
}

function changePassword() {
    const current = document.getElementById('current-password').value;
    const newPass = document.getElementById('new-password').value;
    const confirm = document.getElementById('confirm-password').value;
    
    if (!current || !newPass || !confirm) {
        showNotification('Preencha todos os campos', 'error');
        return;
    }
    
    if (newPass !== confirm) {
        showNotification('As senhas não conferem', 'error');
        return;
    }
    
    showNotification('Funcionalidade em desenvolvimento', 'warning');
}

function refreshDashboard() {
    loadInstances();
    loadSystemHealth();
    showNotification('Dashboard atualizado', 'success');
}

// ========================================
// Helper Functions
// ========================================
function populateInstanceSelects() {
    const selects = [
        document.getElementById('groups-instance-select'),
        document.getElementById('testing-instance-select')
    ];
    
    // Find first connected instance
    const connectedInstance = instances.find(inst => inst.status === 'CONNECTED');
    
    selects.forEach(select => {
        if (!select) return;
        const currentValue = select.value;
        select.innerHTML = '<option value="">Selecione uma instância</option>';
        
        instances.forEach(inst => {
            const option = document.createElement('option');
            option.value = inst.id;
            option.textContent = `${inst.name || inst.id.substring(0, 8)} (${inst.status})`;
            if (inst.status === 'CONNECTED') {
                option.textContent += ' ✅';
            }
            select.appendChild(option);
        });
        
        // Auto-select: keep current value, or select connected instance
        if (currentValue) {
            select.value = currentValue;
        } else if (connectedInstance && !select.value) {
            select.value = connectedInstance.id;
            currentInstance = connectedInstance.id;
        }
    });
    
    // Auto-load groups if we have a connected instance selected
    const groupsSelect = document.getElementById('groups-instance-select');
    if (groupsSelect && groupsSelect.value && groups.length === 0) {
        loadGroups();
    }
    
    // Update testing connection status
    updateTestingConnectionStatus();
}

function updateTestingConnectionStatus() {
    const select = document.getElementById('testing-instance-select');
    const statusSpan = document.getElementById('testing-connection-status');
    if (!select || !statusSpan) return;
    
    const instanceId = select.value;
    if (!instanceId) {
        statusSpan.innerHTML = '<span class="uk-text-warning">⚠️ Selecione uma instância</span>';
        return;
    }
    
    const instance = instances.find(i => i.id === instanceId);
    if (instance && instance.status === 'CONNECTED') {
        statusSpan.innerHTML = '<span class="uk-text-success">✅ Conectado</span>';
    } else {
        statusSpan.innerHTML = '<span class="uk-text-danger">❌ Desconectado</span>';
    }
}

function populateGroupSelect() {
    const select = document.getElementById('test-recipient-group');
    if (!select) return;
    
    select.innerHTML = '<option value="">Selecione um grupo</option>';
    groups.forEach(g => {
        const option = document.createElement('option');
        option.value = g.id;
        option.textContent = g.name;
        select.appendChild(option);
    });
}

function populateUserGroupFilters() {
    const uniqueGroups = [...new Set(users.map(u => u.group).filter(g => g))];
    const selects = [
        document.getElementById('users-filter-group'),
        document.getElementById('new-user-group'),
        document.getElementById('edit-user-group'),
        document.getElementById('import-users-group')
    ];
    
    selects.forEach(select => {
        if (!select) return;
        const firstOption = select.querySelector('option');
        select.innerHTML = '';
        select.appendChild(firstOption);
        
        uniqueGroups.forEach(group => {
            const option = document.createElement('option');
            option.value = group;
            option.textContent = group;
            select.appendChild(option);
        });
    });
}

function updateStats() {
    document.getElementById('stat-instances').textContent = instances.length;
    document.getElementById('stat-connected').textContent = instances.filter(i => i.status === 'CONNECTED').length;
}

function addToMessageHistory(to, message, success) {
    messageHistory.unshift({
        to,
        message,
        success,
        timestamp: new Date().toISOString()
    });
    saveLocalData();
}

function getStatusClass(status) {
    if (status === 'CONNECTED') return 'connected';
    if (status === 'DISCONNECTED' || status === 'AUTH_FAILURE') return 'disconnected';
    if (status === 'QR_CODE') return 'qr';
    return 'loading';
}

function getInitials(name) {
    if (!name) return '?';
    return name.split(' ').map(n => n[0]).slice(0, 2).join('').toUpperCase();
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    
    if (days > 0) return `${days}d ${hours}h ${mins}m`;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
}

function formatTime(isoString) {
    const date = new Date(isoString);
    const now = new Date();
    const diff = now - date;
    
    if (diff < 60000) return 'agora';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm atrás';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h atrás';
    return date.toLocaleDateString();
}

function showNotification(message, type = 'info') {
    UIkit.notification({
        message: `<span uk-icon="icon: ${type === 'success' ? 'check' : type === 'error' ? 'close' : type === 'warning' ? 'warning' : 'info'}"></span> ${message}`,
        status: type === 'error' ? 'danger' : type,
        pos: 'top-right',
        timeout: 3000
    });
}

// Mostrar informações da instância para integração com API
function showInstanceInfo(instanceId) {
    const instance = instances.find(i => i.id === instanceId);
    if (!instance) {
        showNotification('Instância não encontrada', 'error');
        return;
    }
    
    // Gerar token baseado no ID da instância (ou usar token existente)
    const token = instance.token || instanceId;
    
    // Buscar o primeiro grupo conectado como DEFAULT_GROUP_ID
    let defaultGroupId = '---';
    if (groups.length > 0) {
        defaultGroupId = groups[0].id;
    }
    
    // Preencher modal
    document.getElementById('info-instance-id').textContent = instanceId;
    document.getElementById('info-instance-token').textContent = token;
    document.getElementById('info-default-group').textContent = defaultGroupId;
    
    // Abrir modal
    UIkit.modal('#modal-instance-info').show();
}

// Copiar texto para clipboard
function copyToClipboard(elementId) {
    const text = document.getElementById(elementId).textContent;
    navigator.clipboard.writeText(text).then(() => {
        showNotification('Copiado para a área de transferência!', 'success');
    }).catch(() => {
        showNotification('Erro ao copiar', 'error');
    });
}