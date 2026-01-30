<?php
/**
 * WhatsApp Groups API - Classe PHP para integração
 * 
 * Esta classe permite integrar seu sistema PHP com a API de grupos do WhatsApp
 * 
 * Exemplo de uso:
 * 
 * $api = new WhatsAppGroupsAPI('http://localhost:3000', 'sua-instance-id');
 * 
 * // Criar grupo
 * $result = $api->createGroup('Meu Grupo', ['5511999999999', '5511888888888']);
 * 
 * // Enviar mensagem para grupo
 * $api->sendMessageToGroup('grupo-id@g.us', 'Olá grupo!');
 */

class WhatsAppGroupsAPI {
    
    private $baseUrl;
    private $instanceId;
    private $timeout = 30;
    
    /**
     * Construtor
     * 
     * @param string $baseUrl URL base da API (ex: http://localhost:3000)
     * @param string $instanceId ID da instância do WhatsApp
     */
    public function __construct($baseUrl, $instanceId) {
        $this->baseUrl = rtrim($baseUrl, '/');
        $this->instanceId = $instanceId;
    }
    
    /**
     * Define o timeout das requisições
     */
    public function setTimeout($seconds) {
        $this->timeout = $seconds;
    }
    
    /**
     * Faz uma requisição HTTP
     */
    private function request($method, $endpoint, $data = null) {
        $url = $this->baseUrl . $endpoint;
        
        $ch = curl_init();
        curl_setopt($ch, CURLOPT_URL, $url);
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_TIMEOUT, $this->timeout);
        curl_setopt($ch, CURLOPT_HTTPHEADER, [
            'Content-Type: application/json',
            'Accept: application/json'
        ]);
        
        if ($method === 'POST') {
            curl_setopt($ch, CURLOPT_POST, true);
            if ($data) {
                curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($data));
            }
        }
        
        $response = curl_exec($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $error = curl_error($ch);
        curl_close($ch);
        
        if ($error) {
            return [
                'success' => false,
                'error' => 'Erro de conexão: ' . $error,
                'httpCode' => 0
            ];
        }
        
        $result = json_decode($response, true);
        $result['httpCode'] = $httpCode;
        
        return $result;
    }
    
    // ==========================================
    // MÉTODOS DE GRUPOS DO WHATSAPP
    // ==========================================
    
    /**
     * Criar um novo grupo no WhatsApp
     * 
     * @param string $name Nome do grupo
     * @param array $participants Array de números de telefone (com DDI)
     * @param string $description Descrição do grupo (opcional)
     * @return array Resultado da operação
     */
    public function createGroup($name, $participants = [], $description = '') {
        return $this->request('POST', '/api/group/create', [
            'instance' => $this->instanceId,
            'name' => $name,
            'participants' => $participants,
            'description' => $description
        ]);
    }
    
    /**
     * Listar todos os grupos do WhatsApp
     * 
     * @return array Lista de grupos
     */
    public function listGroups() {
        return $this->request('GET', '/api/group/list/' . $this->instanceId);
    }
    
    /**
     * Obter informações de um grupo específico
     * 
     * @param string $groupId ID do grupo (ex: 123456789@g.us)
     * @return array Informações do grupo
     */
    public function getGroupInfo($groupId) {
        $groupId = urlencode($groupId);
        return $this->request('GET', '/api/group/info/' . $this->instanceId . '/' . $groupId);
    }
    
    /**
     * Adicionar participantes a um grupo
     * 
     * @param string $groupId ID do grupo
     * @param array $participants Array de números de telefone
     * @return array Resultado da operação
     */
    public function addParticipants($groupId, $participants) {
        return $this->request('POST', '/api/group/add-participants', [
            'instance' => $this->instanceId,
            'groupId' => $groupId,
            'participants' => $participants
        ]);
    }
    
    /**
     * Remover participantes de um grupo
     * 
     * @param string $groupId ID do grupo
     * @param array $participants Array de números de telefone
     * @return array Resultado da operação
     */
    public function removeParticipants($groupId, $participants) {
        return $this->request('POST', '/api/group/remove-participants', [
            'instance' => $this->instanceId,
            'groupId' => $groupId,
            'participants' => $participants
        ]);
    }
    
    /**
     * Enviar mensagem para um grupo
     * 
     * @param string $groupId ID do grupo
     * @param string $message Mensagem a ser enviada
     * @return array Resultado da operação
     */
    public function sendMessageToGroup($groupId, $message) {
        return $this->request('POST', '/api/group/send-message', [
            'instance' => $this->instanceId,
            'groupId' => $groupId,
            'message' => $message
        ]);
    }
    
    /**
     * Enviar mídia/arquivo para um grupo
     * 
     * Suporta 3 formas de envio:
     * 1. Caminho do arquivo local (filePath)
     * 2. URL remota (mediaUrl)
     * 3. Base64 (mediaBase64 + mimetype)
     * 
     * @param string $groupId ID do grupo (ex: 123456789@g.us)
     * @param string $caption Legenda da mídia (opcional)
     * @param array $options Opções de mídia:
     *   - filePath: caminho do arquivo local
     *   - mediaUrl: URL remota do arquivo
     *   - mediaBase64: conteúdo em base64
     *   - mimetype: tipo MIME (obrigatório com base64)
     *   - filename: nome do arquivo (opcional)
     * @return array Resultado da operação
     * 
     * Exemplos de uso:
     * 
     * // Via caminho do arquivo:
     * $api->sendMediaToGroup('123456789@g.us', 'Legenda', ['filePath' => '/path/to/file.pdf']);
     * 
     * // Via URL:
     * $api->sendMediaToGroup('123456789@g.us', 'Legenda', ['mediaUrl' => 'https://example.com/image.jpg']);
     * 
     * // Via Base64:
     * $api->sendMediaToGroup('123456789@g.us', 'Legenda', [
     *     'mediaBase64' => base64_encode(file_get_contents('/path/to/file.pdf')),
     *     'mimetype' => 'application/pdf',
     *     'filename' => 'documento.pdf'
     * ]);
     */
    public function sendMediaToGroup($groupId, $caption = '', $options = []) {
        // Se for upload de arquivo local, usar multipart/form-data
        if (isset($options['filePath']) && file_exists($options['filePath'])) {
            return $this->uploadFileToGroup($groupId, $options['filePath'], $caption);
        }
        
        // Caso contrário, usar JSON (URL ou Base64)
        $data = [
            'instance' => $this->instanceId,
            'groupId' => $groupId,
            'caption' => $caption
        ];
        
        if (isset($options['mediaUrl'])) {
            $data['mediaUrl'] = $options['mediaUrl'];
        } elseif (isset($options['mediaBase64'])) {
            $data['mediaBase64'] = $options['mediaBase64'];
            $data['mimetype'] = $options['mimetype'] ?? 'application/octet-stream';
            $data['filename'] = $options['filename'] ?? 'arquivo';
        }
        
        return $this->request('POST', '/api/group/send-media', $data);
    }
    
    /**
     * Upload de arquivo local para grupo (multipart/form-data)
     * 
     * @param string $groupId ID do grupo
     * @param string $filePath Caminho do arquivo
     * @param string $caption Legenda
     * @return array Resultado
     */
    private function uploadFileToGroup($groupId, $filePath, $caption = '') {
        $url = $this->baseUrl . '/api/group/send-media';
        
        $ch = curl_init();
        curl_setopt($ch, CURLOPT_URL, $url);
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_TIMEOUT, $this->timeout);
        curl_setopt($ch, CURLOPT_POST, true);
        
        // Preparar dados multipart
        $postData = [
            'instance' => $this->instanceId,
            'groupId' => $groupId,
            'caption' => $caption,
            'file' => new CURLFile($filePath)
        ];
        
        curl_setopt($ch, CURLOPT_POSTFIELDS, $postData);
        
        $response = curl_exec($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $error = curl_error($ch);
        curl_close($ch);
        
        if ($error) {
            return [
                'success' => false,
                'error' => 'Erro de conexão: ' . $error,
                'httpCode' => 0
            ];
        }
        
        $result = json_decode($response, true);
        $result['httpCode'] = $httpCode;
        
        return $result;
    }
    
    /**
     * Obter link de convite do grupo
     * 
     * @param string $groupId ID do grupo
     * @return array Link de convite
     */
    public function getInviteLink($groupId) {
        $groupId = urlencode($groupId);
        return $this->request('GET', '/api/group/invite-link/' . $this->instanceId . '/' . $groupId);
    }
    
    /**
     * Atualizar informações do grupo
     * 
     * @param string $groupId ID do grupo
     * @param string|null $name Novo nome (opcional)
     * @param string|null $description Nova descrição (opcional)
     * @return array Resultado da operação
     */
    public function updateGroup($groupId, $name = null, $description = null) {
        $data = [
            'instance' => $this->instanceId,
            'groupId' => $groupId
        ];
        
        if ($name !== null) $data['name'] = $name;
        if ($description !== null) $data['description'] = $description;
        
        return $this->request('POST', '/api/group/update', $data);
    }
    
    // ==========================================
    // MÉTODOS DE GRUPOS LOCAIS (BANCO DE DADOS)
    // ==========================================
    
    /**
     * Listar grupos salvos localmente
     * 
     * @return array Lista de grupos locais
     */
    public function listLocalGroups() {
        return $this->request('GET', '/api/local-groups/' . $this->instanceId);
    }
    
    /**
     * Criar grupo local (cria no WhatsApp e salva no banco)
     * 
     * @param string $name Nome do grupo
     * @param string $description Descrição
     * @param array $members Array de membros [['phone' => '...', 'name' => '...'], ...]
     * @return array Resultado com IDs local e do WhatsApp
     */
    public function createLocalGroup($name, $description = '', $members = []) {
        return $this->request('POST', '/api/local-groups/create', [
            'instance' => $this->instanceId,
            'name' => $name,
            'description' => $description,
            'members' => $members
        ]);
    }
    
    /**
     * Adicionar membro a um grupo local
     * 
     * @param int $localGroupId ID do grupo local (do banco)
     * @param string $phone Telefone do membro
     * @param string $name Nome do membro (opcional)
     * @return array Resultado da operação
     */
    public function addMemberToLocalGroup($localGroupId, $phone, $name = '') {
        return $this->request('POST', '/api/local-groups/add-member', [
            'localGroupId' => $localGroupId,
            'phone' => $phone,
            'name' => $name
        ]);
    }
    
    /**
     * Listar membros de um grupo local
     * 
     * @param int $localGroupId ID do grupo local
     * @return array Lista de membros
     */
    public function listLocalGroupMembers($localGroupId) {
        return $this->request('GET', '/api/local-groups/' . $localGroupId . '/members');
    }
    
    /**
     * Enviar mensagem para grupo local
     * 
     * @param int $localGroupId ID do grupo local
     * @param string $message Mensagem
     * @return array Resultado da operação
     */
    public function sendMessageToLocalGroup($localGroupId, $message) {
        return $this->request('POST', '/api/local-groups/send-message', [
            'localGroupId' => $localGroupId,
            'message' => $message
        ]);
    }
    
    // ==========================================
    // MÉTODOS DE MENSAGENS INDIVIDUAIS (existentes)
    // ==========================================
    
    /**
     * Enviar mensagem de texto para um número
     * 
     * @param string $to Número de telefone (com DDI)
     * @param string $message Mensagem
     * @return array Resultado da operação
     */
    public function sendText($to, $message) {
        return $this->request('POST', '/api/send-text', [
            'instance' => $this->instanceId,
            'to' => $to,
            'message' => $message
        ]);
    }
    
    /**
     * Enviar mídia/arquivo para um número individual
     * 
     * Suporta 3 formas de envio:
     * 1. Caminho do arquivo local (filePath)
     * 2. URL remota (mediaUrl)
     * 3. Base64 (mediaBase64 + mimetype)
     * 
     * @param string $to Número de telefone (com DDI)
     * @param string $caption Legenda da mídia (opcional)
     * @param array $options Opções de mídia:
     *   - filePath: caminho do arquivo local
     *   - mediaUrl: URL remota do arquivo
     *   - mediaBase64: conteúdo em base64
     *   - mimetype: tipo MIME (obrigatório com base64)
     *   - filename: nome do arquivo (opcional)
     * @return array Resultado da operação
     * 
     * Exemplos de uso:
     * 
     * // Via caminho do arquivo:
     * $api->sendMedia('5511999999999', 'Legenda', ['filePath' => '/path/to/file.pdf']);
     * 
     * // Via URL:
     * $api->sendMedia('5511999999999', 'Legenda', ['mediaUrl' => 'https://example.com/image.jpg']);
     * 
     * // Via Base64:
     * $api->sendMedia('5511999999999', 'Legenda', [
     *     'mediaBase64' => base64_encode(file_get_contents('/path/to/file.pdf')),
     *     'mimetype' => 'application/pdf',
     *     'filename' => 'documento.pdf'
     * ]);
     */
    public function sendMedia($to, $caption = '', $options = []) {
        // Se for upload de arquivo local, usar multipart/form-data
        if (isset($options['filePath']) && file_exists($options['filePath'])) {
            return $this->uploadFile($to, $options['filePath'], $caption);
        }
        
        // Caso contrário, usar JSON (URL ou Base64)
        $data = [
            'instance' => $this->instanceId,
            'to' => $to,
            'caption' => $caption
        ];
        
        if (isset($options['mediaUrl'])) {
            $data['mediaUrl'] = $options['mediaUrl'];
        } elseif (isset($options['mediaBase64'])) {
            $data['mediaBase64'] = $options['mediaBase64'];
            $data['mimetype'] = $options['mimetype'] ?? 'application/octet-stream';
            $data['filename'] = $options['filename'] ?? 'arquivo';
        }
        
        return $this->request('POST', '/api/send-media', $data);
    }
    
    /**
     * Upload de arquivo local para contato individual (multipart/form-data)
     * 
     * @param string $to Número de telefone
     * @param string $filePath Caminho do arquivo
     * @param string $caption Legenda
     * @return array Resultado
     */
    private function uploadFile($to, $filePath, $caption = '') {
        $url = $this->baseUrl . '/api/send-media';
        
        $ch = curl_init();
        curl_setopt($ch, CURLOPT_URL, $url);
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_TIMEOUT, $this->timeout);
        curl_setopt($ch, CURLOPT_POST, true);
        
        // Preparar dados multipart
        $postData = [
            'instance' => $this->instanceId,
            'to' => $to,
            'caption' => $caption,
            'file' => new CURLFile($filePath)
        ];
        
        curl_setopt($ch, CURLOPT_POSTFIELDS, $postData);
        
        $response = curl_exec($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $error = curl_error($ch);
        curl_close($ch);
        
        if ($error) {
            return [
                'success' => false,
                'error' => 'Erro de conexão: ' . $error,
                'httpCode' => 0
            ];
        }
        
        $result = json_decode($response, true);
        $result['httpCode'] = $httpCode;
        
        return $result;
    }
    
    /**
     * Verificar status da instância
     * 
     * @return array Status da instância
     */
    public function getStatus() {
        return $this->request('GET', '/api/session/status/' . $this->instanceId);
    }
    
    /**
     * Verificar saúde da API
     * 
     * @return array Informações de saúde
     */
    public function healthCheck() {
        return $this->request('GET', '/api/health');
    }
}
