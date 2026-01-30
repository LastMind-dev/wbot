<?php
/**
 * Exemplo de uso da API de Grupos WhatsApp
 * 
 * Este arquivo demonstra como usar a classe WhatsAppGroupsAPI
 * para gerenciar grupos no seu sistema PHP
 */

require_once 'WhatsAppGroupsAPI.php';

// Configuração
$API_URL = 'http://localhost:3000';  // URL da sua API Node.js
$INSTANCE_ID = 'sua-instance-id';     // ID da instância (pegar no dashboard /admin)

// Inicializar a API
$whatsapp = new WhatsAppGroupsAPI($API_URL, $INSTANCE_ID);

// ==========================================
// EXEMPLOS DE USO
// ==========================================

echo "<h1>Exemplos de Uso - WhatsApp Groups API</h1>";

// 1. Verificar status da conexão
echo "<h2>1. Status da Conexão</h2>";
$status = $whatsapp->getStatus();
echo "<pre>" . json_encode($status, JSON_PRETTY_PRINT) . "</pre>";

// 2. Criar um novo grupo
echo "<h2>2. Criar Grupo</h2>";
$novoGrupo = $whatsapp->createGroup(
    'Grupo de Teste',                    // Nome do grupo
    ['5511999999999', '5511888888888'],  // Participantes (números com DDI)
    'Descrição do grupo de teste'        // Descrição (opcional)
);
echo "<pre>" . json_encode($novoGrupo, JSON_PRETTY_PRINT) . "</pre>";

// 3. Listar todos os grupos
echo "<h2>3. Listar Grupos</h2>";
$grupos = $whatsapp->listGroups();
echo "<pre>" . json_encode($grupos, JSON_PRETTY_PRINT) . "</pre>";

// 4. Obter informações de um grupo específico
echo "<h2>4. Info do Grupo</h2>";
if (isset($novoGrupo['group']['id'])) {
    $groupId = $novoGrupo['group']['id'];
    $info = $whatsapp->getGroupInfo($groupId);
    echo "<pre>" . json_encode($info, JSON_PRETTY_PRINT) . "</pre>";
}

// 5. Adicionar participantes
echo "<h2>5. Adicionar Participantes</h2>";
if (isset($groupId)) {
    $resultado = $whatsapp->addParticipants($groupId, ['5511777777777']);
    echo "<pre>" . json_encode($resultado, JSON_PRETTY_PRINT) . "</pre>";
}

// 6. Enviar mensagem para o grupo
echo "<h2>6. Enviar Mensagem para Grupo</h2>";
if (isset($groupId)) {
    $mensagem = $whatsapp->sendMessageToGroup($groupId, 'Olá pessoal! Esta é uma mensagem de teste.');
    echo "<pre>" . json_encode($mensagem, JSON_PRETTY_PRINT) . "</pre>";
}

// 7. Obter link de convite
echo "<h2>7. Link de Convite</h2>";
if (isset($groupId)) {
    $link = $whatsapp->getInviteLink($groupId);
    echo "<pre>" . json_encode($link, JSON_PRETTY_PRINT) . "</pre>";
}

// ==========================================
// USANDO GRUPOS LOCAIS (salvos no banco)
// ==========================================

echo "<h1>Grupos Locais (Banco de Dados)</h1>";

// 8. Criar grupo local com membros
echo "<h2>8. Criar Grupo Local</h2>";
$grupoLocal = $whatsapp->createLocalGroup(
    'Clientes VIP',
    'Grupo para clientes especiais',
    [
        ['phone' => '5511999999999', 'name' => 'João Silva'],
        ['phone' => '5511888888888', 'name' => 'Maria Santos'],
        ['phone' => '5511777777777', 'name' => 'Pedro Costa']
    ]
);
echo "<pre>" . json_encode($grupoLocal, JSON_PRETTY_PRINT) . "</pre>";

// 9. Listar grupos locais
echo "<h2>9. Listar Grupos Locais</h2>";
$gruposLocais = $whatsapp->listLocalGroups();
echo "<pre>" . json_encode($gruposLocais, JSON_PRETTY_PRINT) . "</pre>";

// 10. Adicionar membro ao grupo local
echo "<h2>10. Adicionar Membro ao Grupo Local</h2>";
if (isset($grupoLocal['localGroupId'])) {
    $localId = $grupoLocal['localGroupId'];
    $addMembro = $whatsapp->addMemberToLocalGroup($localId, '5511666666666', 'Ana Paula');
    echo "<pre>" . json_encode($addMembro, JSON_PRETTY_PRINT) . "</pre>";
}

// 11. Listar membros do grupo local
echo "<h2>11. Membros do Grupo Local</h2>";
if (isset($localId)) {
    $membros = $whatsapp->listLocalGroupMembers($localId);
    echo "<pre>" . json_encode($membros, JSON_PRETTY_PRINT) . "</pre>";
}

// 12. Enviar mensagem para grupo local
echo "<h2>12. Enviar Mensagem para Grupo Local</h2>";
if (isset($localId)) {
    $msg = $whatsapp->sendMessageToLocalGroup($localId, 'Mensagem enviada via sistema PHP!');
    echo "<pre>" . json_encode($msg, JSON_PRETTY_PRINT) . "</pre>";
}

?>

<style>
    body { font-family: Arial, sans-serif; padding: 20px; max-width: 1200px; margin: 0 auto; }
    h1 { color: #25D366; border-bottom: 2px solid #25D366; padding-bottom: 10px; }
    h2 { color: #333; margin-top: 30px; }
    pre { background: #f5f5f5; padding: 15px; border-radius: 5px; overflow-x: auto; }
</style>
