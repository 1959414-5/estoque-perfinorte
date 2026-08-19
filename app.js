// ============================================================
// API — wrapper que fala com o Apps Script via HTTP.
// Substitui o antigo google.script.run.
// ============================================================
async function api(acao, params) {
  if (!window.APP_CONFIG || !window.APP_CONFIG.API_URL || window.APP_CONFIG.API_URL.indexOf('COLE_AQUI') === 0) {
    throw new Error('config.js não foi editado. Cole a URL do Apps Script e o token lá.');
  }
  const body = Object.assign({ acao: acao, token: window.APP_CONFIG.APP_TOKEN }, params || {});
  const resp = await fetch(window.APP_CONFIG.API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(body),
    redirect: 'follow'
  });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  const j = await resp.json();
  if (!j.ok) throw new Error(j.erro || 'Erro desconhecido');
  return j.dados;
}

// Repete a chamada automaticamente se falhar — só deve ser usada em ações
// SEGURAS de repetir (leitura, verificar PIN), nunca em ações que alteram
// dado (registrar movimento, salvar status etc.), pra não correr o risco de
// aplicar a mesma coisa duas vezes se a 1ª tentativa na verdade tiver dado
// certo e só a resposta que se perdeu. O Google Apps Script às vezes tem uma
// folga de alguns segundos logo depois que o código é editado/republicado —
// isso resolve sozinho na 2ª ou 3ª tentativa quase sempre.
async function apiComRetry(acao, params, tentativas) {
  tentativas = tentativas || 3;
  let ultimoErro;
  for (let i = 0; i < tentativas; i++) {
    try {
      return await api(acao, params);
    } catch (e) {
      ultimoErro = e;
      if (i < tentativas - 1) await new Promise(r => setTimeout(r, 700 * (i + 1)));
    }
  }
  throw ultimoErro;
}


let CONFIG = { status: [], linhas: [], solicitantes: [] };
let CATALOGO = [];
let SOLICITACOES = [];

let PECA_IMAGEM_BASE64 = null;    // nova foto anexada no form de peça (se trocou)
let PECA_IMAGEM_ETIQUETA_BASE64 = null;  // nova foto exclusiva pra etiqueta (se trocou)
let PECA_IMAGEM_URL_ATUAL = '';   // url já existente da peça (se editando)
let PECA_IMAGEM_ETIQUETA_URL_ATUAL = '';   // url já existente da imagem de etiqueta (se editando)
let MODO_PECA_ORIGEM = 'catalogo'; // 'catalogo' | 'solicitacao' — de onde abriu o form de peça

let FILTRO_STATUS = localStorage.getItem('filtroStatus') || 'Todos';
let FILTRO_PERIODO = localStorage.getItem('filtroPeriodo') || 'hoje';
let FILTRO_LINHA_PICKER = 'Todas';
let FILTRO_LINHA_CATALOGO = localStorage.getItem('filtroLinhaCatalogo') || 'Todas';
let FILTRO_ESTOQUE_BAIXO = localStorage.getItem('filtroEstoqueBaixo') === 'true';
let MOVIMENTO_PECA_ATUAL = null;
let MOVIMENTO_TIPO_ATUAL = 'entrada';
let MOVIMENTO_ID_SOLICITACAO_ATUAL = null;

// ---------------------------------------------------------
// INIT
// ---------------------------------------------------------
document.addEventListener('DOMContentLoaded', function () {
  api('getConfig')
    .then(function (cfg) {
      CONFIG = cfg;
      montarSelectLinhaPeca();
      montarChipsLinha('picker-linha-chips', filtrarPickerPeca, 'FILTRO_LINHA_PICKER');
    })
    .catch(function (err) {
      toast('Erro ao carregar configuração: ' + err.message);
    });

  document.getElementById('lista-catalogo').innerHTML = '<div class="empty-state">Carregando peças...</div>';
  carregarCatalogo();
  carregarSolicitacoes();
  atualizarBotaoModoAdmin();
  atualizarBadgeFiltros();
  document.getElementById('badge-filtros-catalogo-ativos').classList.toggle('hidden',
    !(FILTRO_LINHA_CATALOGO !== 'Todas' || FILTRO_ESTOQUE_BAIXO));

  // Atualiza o catálogo sozinho a cada 45s, mas só se a aba Catálogo estiver
  // aberta na hora — sem gastar chamada à toa enquanto a pessoa está em
  // Nova Solicitação ou no Painel.
  setInterval(function () {
    if (document.getElementById('view-catalogo').classList.contains('view-active') && document.visibilityState === 'visible') {
      carregarCatalogo(true);
    }
  }, 45000);

  const abaSalva = localStorage.getItem('abaAtual');
  if (abaSalva && document.getElementById('view-' + abaSalva)) {
    trocarView(abaSalva);
  }

  document.querySelectorAll('.nav-btn').forEach(btn => {
    if (btn.dataset.view) btn.addEventListener('click', () => trocarView(btn.dataset.view));
  });

  document.getElementById('peca-foto-camera').addEventListener('change', e => handleFotoChange(e, 'peca'));
  document.getElementById('peca-foto-etiqueta-camera').addEventListener('change', e => handleFotoChange(e, 'etiqueta'));
  document.getElementById('peca-foto-etiqueta-arquivo').addEventListener('change', e => handleFotoChange(e, 'etiqueta'));
  document.getElementById('inp-confirmacao-camera').addEventListener('change', e => handleUploadPedido(e, 'confirmacao'));
  document.getElementById('inp-confirmacao-arquivo').addEventListener('change', e => handleUploadPedido(e, 'confirmacao'));
  document.getElementById('inp-localizacao-camera').addEventListener('change', e => handleUploadPedido(e, 'localizacao'));
  document.getElementById('inp-localizacao-arquivo').addEventListener('change', e => handleUploadPedido(e, 'localizacao'));

  document.getElementById('lista-painel').addEventListener('click', function (e) {
    const card = e.target.closest('.ticket');
    if (card && card.dataset.pedidoId) abrirDetalhePedido(card.dataset.pedidoId);
  });

  const cropWrap = document.getElementById('crop-canvas-wrap');
  cropWrap.addEventListener('mousedown', cropIniciar);
  cropWrap.addEventListener('mousemove', cropMover);
  window.addEventListener('mouseup', cropFinalizar);
  cropWrap.addEventListener('touchstart', cropIniciar, { passive: true });
  cropWrap.addEventListener('touchmove', cropMover, { passive: true });
  cropWrap.addEventListener('touchend', cropFinalizar);
  document.getElementById('peca-foto-arquivo').addEventListener('change', e => handleFotoChange(e, 'peca'));

  document.getElementById('form-peca').addEventListener('submit', salvarPecaCatalogo);

  document.getElementById('inp-busca-catalogo').addEventListener('input', renderCatalogoLista);
  document.getElementById('inp-busca-picker').addEventListener('input', filtrarPickerPeca);
  document.getElementById('peca-id-input').addEventListener('blur', verificarIdDuplicado);
  document.getElementById('inp-foto-qr').addEventListener('change', handleFotoQR);
});

function trocarView(nome) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('view-active'));
  document.getElementById('view-' + nome).classList.add('view-active');
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('nav-active', b.dataset.view === nome));
  localStorage.setItem('abaAtual', nome);
  if (nome === 'painel') carregarSolicitacoes();
  if (nome === 'catalogo') carregarCatalogo();
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
}

// ---------------------------------------------------------
// CONFIG — selects / chips dinâmicos
// ---------------------------------------------------------
function montarSelectLinhaPeca() {
  const sel = document.getElementById('peca-linha');
  sel.innerHTML = CONFIG.linhas.map(l => '<option value="' + esc(l) + '">' + esc(l) + '</option>').join('');
}

function montarChipsLinha(containerId, onChangeFn, filtroVarName) {
  const wrap = document.getElementById(containerId);
  const opcoes = ['Todas'].concat(CONFIG.linhas);
  wrap.innerHTML = opcoes.map((l, i) =>
    '<div class="filter-chip' + (i === 0 ? ' selected' : '') + '" data-linha="' + esc(l) + '">' + esc(l) + '</div>'
  ).join('');
  wrap.querySelectorAll('.filter-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      wrap.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('selected'));
      chip.classList.add('selected');
      if (filtroVarName === 'FILTRO_LINHA_PICKER') FILTRO_LINHA_PICKER = chip.dataset.linha;
      if (filtroVarName === 'FILTRO_LINHA_CATALOGO') FILTRO_LINHA_CATALOGO = chip.dataset.linha;
      onChangeFn();
    });
  });
}

// ---------------------------------------------------------
// CATÁLOGO — carregamento
// ---------------------------------------------------------
function carregarCatalogo(silencioso) {
  const btn = document.getElementById('btn-atualizar-catalogo');
  if (btn) btn.disabled = true;

  apiComRetry('getCatalogo')
    .then(function (lista) {
      CATALOGO = lista || [];
      renderCatalogoLista();
      renderPainelAlertas();
      if (CATALOGO.length === 0) rodarDiagnosticoCatalogo();
      if (document.getElementById('modal-picker-peca').classList.contains('hidden') === false) {
        filtrarPickerPeca();
      }
    })
    .catch(function (err) {
      // Depois de 3 tentativas ainda falhou — se for atualização automática
      // em segundo plano, não assusta ninguém com toast; só tenta de novo no
      // próximo ciclo. Se for ação manual (clicou em algo), aí sim avisa.
      if (!CATALOGO.length) {
        document.getElementById('lista-catalogo').innerHTML =
          '<div class="empty-state"><div class="big">Erro ao carregar</div>' + esc(err.message) + '</div>';
      }
      if (!silencioso) toast('Erro ao carregar catálogo: ' + err.message);
    })
    .finally(function () { if (btn) btn.disabled = false; });
}

function rodarDiagnosticoCatalogo() {
  api('diagnosticoCatalogo')
    .then(function (info) {
      if (CATALOGO.length > 0) return; // carregou algo enquanto isso, ignora
      const wrap = document.getElementById('lista-catalogo');
      wrap.innerHTML =
        '<div class="empty-state">' +
        '<div class="big">Nenhuma peça encontrada pelo servidor</div>' +
        'Manda um print disso pra mim:' +
        '<pre style="text-align:left; background:#fff; border:1px solid var(--line); border-radius:8px; padding:10px; margin-top:10px; font-size:11px; white-space:pre-wrap; overflow-wrap:anywhere;">' +
        esc(JSON.stringify(info, null, 2)) +
        '</pre></div>';
    })
    .catch(function (err) {
      const wrap = document.getElementById('lista-catalogo');
      wrap.innerHTML += '<div class="empty-state">Diagnóstico também falhou: ' + esc(err.message) + '</div>';
    });
}

function thumbHtml(imagemUrl, tamanhoClasse) {
  tamanhoClasse = tamanhoClasse || 'thumb';
  if (imagemUrl) {
    return '<img class="' + tamanhoClasse + '" src="' + imagemUrl + '" onclick="event.stopPropagation(); abrirImagemFullscreen(\'' + imagemUrl.replace(/'/g, "\\'") + '\')">';
  }
  return '<div class="' + tamanhoClasse + '-placeholder">▭</div>';
}

let LIGHTBOX_ROTACAO = 0;
let LIGHTBOX_ZOOM = 1;
let LIGHTBOX_GALERIA = [];
let LIGHTBOX_INDICE = 0;

// Abre uma imagem avulsa (mantém compatível com todo lugar que já chamava
// isso — foto de peça, imagem do catálogo etc.) — por trás, é só uma
// "galeria" de 1 imagem só, então as setas de navegar ficam escondidas.
function abrirImagemFullscreen(url) {
  abrirGaleriaFullscreen([url], 0);
}

// Abre a galeria de anexos de um pedido (Ordem de Produção ou Carregamento)
// direto em tela cheia, já na primeira imagem, com setas se tiver mais de uma.
function abrirGaleriaAnexosPedido(tipo) {
  const cfg = TIPOS_ANEXO_PEDIDO[tipo];
  const pd = PEDIDOS_CACHE.find(x => x.pedidoId === PEDIDO_DETALHE_ATUAL);
  if (!pd) return;
  const raw = pd.itens.find(it => it[cfg.campoUrl])?.[cfg.campoUrl];
  const urls = raw ? String(raw).split('\n').filter(Boolean) : [];
  if (!urls.length) return;
  abrirGaleriaFullscreen(urls, 0);
}

function abrirGaleriaFullscreen(urls, indiceInicial) {
  LIGHTBOX_GALERIA = urls;
  LIGHTBOX_INDICE = indiceInicial || 0;
  permitirZoomNativoPagina(true);
  mostrarImagemGaleriaAtual();
  document.getElementById('modal-lightbox').classList.remove('hidden');
}

function mostrarImagemGaleriaAtual() {
  LIGHTBOX_ROTACAO = 0;
  LIGHTBOX_ZOOM = 1;
  const img = document.getElementById('lightbox-img');
  img.src = LIGHTBOX_GALERIA[LIGHTBOX_INDICE];
  img.style.transform = 'rotate(0deg) scale(1)';

  const temVarias = LIGHTBOX_GALERIA.length > 1;
  document.getElementById('lightbox-nav-controls').classList.toggle('hidden', !temVarias);
  const contador = document.getElementById('lightbox-contador');
  contador.classList.toggle('hidden', !temVarias);
  if (temVarias) contador.textContent = (LIGHTBOX_INDICE + 1) + ' / ' + LIGHTBOX_GALERIA.length;
}

function navegarGaleria(direcao) {
  if (LIGHTBOX_GALERIA.length < 2) return;
  LIGHTBOX_INDICE = (LIGHTBOX_INDICE + direcao + LIGHTBOX_GALERIA.length) % LIGHTBOX_GALERIA.length;
  mostrarImagemGaleriaAtual();
}

function aplicarTransformLightbox() {
  document.getElementById('lightbox-img').style.transform = 'rotate(' + LIGHTBOX_ROTACAO + 'deg) scale(' + LIGHTBOX_ZOOM + ')';
}

function rotacionarImagemFullscreen(graus) {
  LIGHTBOX_ROTACAO = (LIGHTBOX_ROTACAO + graus + 360) % 360;
  aplicarTransformLightbox();
}

function zoomLightbox(delta) {
  LIGHTBOX_ZOOM = Math.min(3, Math.max(1, Math.round((LIGHTBOX_ZOOM + delta) * 10) / 10));
  aplicarTransformLightbox();
}

function fecharImagemFullscreen() {
  document.getElementById('modal-lightbox').classList.add('hidden');
  document.getElementById('lightbox-img').src = '';
  permitirZoomNativoPagina(false);
}

// O app trava o zoom por beliscão (pinch) no resto da tela, pra não bagunçar
// os toques nos botões — mas dentro do visualizador de foto isso atrapalha,
// então libera só enquanto ele estiver aberto e trava de novo ao fechar.
function permitirZoomNativoPagina(permitir) {
  const meta = document.querySelector('meta[name="viewport"]');
  if (!meta) return;
  meta.setAttribute('content', permitir
    ? 'width=device-width, initial-scale=1'
    : 'width=device-width, initial-scale=1, maximum-scale=1');
}

// ---------------------------------------------------------
// SELETOR DE PEÇA (Nova Solicitação)
// ---------------------------------------------------------
let PICKER_CALLBACK = null;

function abrirPickerPeca(callback) {
  PICKER_CALLBACK = callback;
  document.getElementById('inp-busca-picker').value = '';
  FILTRO_LINHA_PICKER = 'Todas';
  document.querySelectorAll('#picker-linha-chips .filter-chip').forEach((c, i) => c.classList.toggle('selected', i === 0));
  filtrarPickerPeca();
  document.getElementById('modal-picker-peca').classList.remove('hidden');
}

function fecharPickerPeca() {
  document.getElementById('modal-picker-peca').classList.add('hidden');
}

function filtrarPickerPeca() {
  const termo = (document.getElementById('inp-busca-picker').value || '').toLowerCase();
  const wrap = document.getElementById('lista-picker');
  let filtradas = CATALOGO.filter(p =>
    (p.Nome_Peca || '').toLowerCase().includes(termo) ||
    String(p.ID_Peca || '').toLowerCase().includes(termo)
  );
  if (FILTRO_LINHA_PICKER !== 'Todas') filtradas = filtradas.filter(p => p.Linha === FILTRO_LINHA_PICKER);

  wrap.innerHTML = '';
  if (filtradas.length === 0) {
    wrap.innerHTML = '<div class="empty-state">Nenhuma peça encontrada.</div>';
    return;
  }
  filtradas.slice(0, 60).forEach(p => {
    const div = document.createElement('div');
    div.className = 'picker-item';
    div.style.cursor = 'pointer';
    div.innerHTML = thumbHtml(p.Imagem_URL) +
      '<div class="picker-item-text">' +
      '<div class="picker-item-title">' + esc(p.Nome_Peca) + '</div>' +
      '<div class="picker-item-sub">' + esc(p.MP || '') + (p.Espessura ? ' · ' + esc(formatarEspessura(p.Espessura)) : '') + ' · ' + esc(p.Linha || '') + '</div>' +
      '</div>';
    div.addEventListener('click', () => {
      fecharPickerPeca();
      if (PICKER_CALLBACK) PICKER_CALLBACK(p);
    });
    wrap.appendChild(div);
  });
}

// ---------------------------------------------------------
// MODAL NOVA/EDITAR PEÇA
// ---------------------------------------------------------
function abrirModalPecaNova(origem) {
  MODO_PECA_ORIGEM = origem || 'catalogo';
  document.getElementById('form-peca').reset();
  document.getElementById('peca-id-edicao').value = '';
  document.getElementById('peca-id-input').value = '';
  document.getElementById('peca-id-input').disabled = false;
  document.getElementById('peca-id-input').classList.remove('id-invalido');
  document.getElementById('peca-id-aviso').textContent = '';
  PECA_IMAGEM_BASE64 = null;
  PECA_IMAGEM_URL_ATUAL = '';
  document.getElementById('peca-imagem-preview').style.display = 'none';
  PECA_IMAGEM_ETIQUETA_BASE64 = null;
  PECA_IMAGEM_ETIQUETA_URL_ATUAL = '';
  document.getElementById('peca-imagem-etiqueta-preview').style.display = 'none';
  document.getElementById('btn-remover-peca').style.display = 'none';
  document.getElementById('btn-imprimir-etiqueta').style.display = 'none';
  document.getElementById('campo-peca-ativo').style.display = 'none';
  document.getElementById('peca-ativo').checked = true;
  document.getElementById('peca-estoque-atual').value = '';
  document.getElementById('peca-estoque-minimo').value = '';
  document.getElementById('peca-estoque-maximo').value = '';
  document.getElementById('modal-peca-titulo').textContent = 'Nova peça no catálogo';
  document.getElementById('modal-peca').classList.remove('hidden');
}

function abrirModalPecaDoPicker() {
  fecharPickerPeca();
  abrirModalPecaNova('solicitacao');
}

function fecharModalPeca() {
  document.getElementById('modal-peca').classList.add('hidden');
}

function editarPecaExistente(id) {
  const p = CATALOGO.find(x => x.ID_Peca === id);
  if (!p) return;
  MODO_PECA_ORIGEM = 'catalogo';
  document.getElementById('peca-id-edicao').value = p.ID_Peca;
  document.getElementById('peca-id-input').value = p.ID_Peca || '';
  document.getElementById('peca-id-input').disabled = true;
  document.getElementById('peca-id-input').classList.remove('id-invalido');
  document.getElementById('peca-id-aviso').textContent = '';
  document.getElementById('peca-nome').value = p.Nome_Peca || '';
  document.getElementById('peca-linha').value = p.Linha || CONFIG.linhas[0];
  document.getElementById('peca-mp').value = p.MP || '';
  document.getElementById('peca-espessura').value = String(p.Espessura || '').replace('.', ',');
  document.getElementById('peca-servicos').value = p.Servicos || '';
  document.getElementById('peca-obs').value = p.Observacoes || '';
  document.getElementById('peca-largura').value = p['Largura do Produto'] || '';
  document.getElementById('peca-comprimento').value = p['Comprimento do Produto'] || '';
  document.getElementById('peca-estoque-atual').value = p['Estoque_Atual'] || 0;
  document.getElementById('peca-estoque-minimo').value = p['Estoque_Minimo'] || 0;
  document.getElementById('peca-estoque-maximo').value = p['Estoque_Maximo'] || '';
  document.getElementById('campo-peca-ativo').style.display = 'block';
  document.getElementById('peca-ativo').checked = p.Ativo !== false;

  PECA_IMAGEM_BASE64 = null;
  PECA_IMAGEM_URL_ATUAL = p.Imagem_URL || '';
  const preview = document.getElementById('peca-imagem-preview');
  if (PECA_IMAGEM_URL_ATUAL) { preview.src = PECA_IMAGEM_URL_ATUAL; preview.style.display = 'block'; }
  else { preview.style.display = 'none'; }

  PECA_IMAGEM_ETIQUETA_BASE64 = null;
  PECA_IMAGEM_ETIQUETA_URL_ATUAL = p.Imagem_Etiqueta_URL || '';
  const previewEtiqueta = document.getElementById('peca-imagem-etiqueta-preview');
  if (PECA_IMAGEM_ETIQUETA_URL_ATUAL) { previewEtiqueta.src = PECA_IMAGEM_ETIQUETA_URL_ATUAL; previewEtiqueta.style.display = 'block'; }
  else { previewEtiqueta.style.display = 'none'; }

  document.getElementById('btn-remover-peca').style.display = 'block';
  document.getElementById('btn-imprimir-etiqueta').style.display = 'block';
  document.getElementById('modal-peca-titulo').textContent = 'Editar peça';
  document.getElementById('modal-peca').classList.remove('hidden');
}

function verificarIdDuplicado() {
  const idEdicao = document.getElementById('peca-id-edicao').value;
  if (idEdicao) return; // editando — ID travado, não precisa checar
  const id = document.getElementById('peca-id-input').value.trim();
  const campo = document.getElementById('peca-id-input');
  const aviso = document.getElementById('peca-id-aviso');
  if (!id) { campo.classList.remove('id-invalido'); aviso.textContent = ''; return; }
  api('pecaIdExiste', { id: id })
    .then(function (existe) {
      if (existe) {
        campo.classList.add('id-invalido');
        aviso.textContent = 'Esse ID já existe no catálogo.';
      } else {
        campo.classList.remove('id-invalido');
        aviso.textContent = '';
      }
    })
    .catch(function () { /* checagem best-effort, não bloqueia digitação */ });
}

function salvarPecaCatalogo(e) {
  e.preventDefault();
  const idEdicao = document.getElementById('peca-id-edicao').value;
  const idDigitado = document.getElementById('peca-id-input').value.trim();
  const peca = {
    id: idEdicao || idDigitado,
    nome: document.getElementById('peca-nome').value.trim(),
    linha: document.getElementById('peca-linha').value,
    mp: document.getElementById('peca-mp').value.trim(),
    espessura: document.getElementById('peca-espessura').value.trim().replace('.', ','),
    servicos: document.getElementById('peca-servicos').value.trim(),
    observacoes: document.getElementById('peca-obs').value.trim(),
    largura: document.getElementById('peca-largura').value.trim(),
    comprimento: document.getElementById('peca-comprimento').value.trim(),
    estoqueAtual: document.getElementById('peca-estoque-atual').value.trim(),
    estoqueMinimo: document.getElementById('peca-estoque-minimo').value.trim(),
    estoqueMaximo: document.getElementById('peca-estoque-maximo').value.trim(),
    ativo: document.getElementById('peca-ativo').checked,
    imagemUrl: PECA_IMAGEM_URL_ATUAL,
    imagemBase64: PECA_IMAGEM_BASE64,
    imagemEtiquetaUrl: PECA_IMAGEM_ETIQUETA_URL_ATUAL,
    imagemEtiquetaBase64: PECA_IMAGEM_ETIQUETA_BASE64
  };
  if (!idEdicao && !idDigitado) { toast('Informe o ID da peça'); return; }
  if (!peca.nome) { toast('Dê um nome pra peça'); return; }

  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true;

  if (idEdicao) {
    api('editarPeca', { peca: peca })
    .then(function () {
        toast('Peça atualizada');
        fecharModalPeca();
        carregarCatalogo();
        btn.disabled = false;
      })
    .catch(function (err) {
        toast('Erro ao atualizar: ' + err.message);
        btn.disabled = false;
      });
  } else {
    api('salvarPeca', { peca: peca })
    .then(function (resultado) {
        toast('Peça cadastrada');
        fecharModalPeca();
        carregarCatalogo();
        if (MODO_PECA_ORIGEM === 'solicitacao' && PICKER_CALLBACK) {
          PICKER_CALLBACK({
            ID_Peca: resultado.id, Nome_Peca: resultado.nome,
            MP: resultado.mp, Espessura: resultado.espessura,
            Linha: resultado.linha, Imagem_URL: resultado.imagemUrl
          });
        }
        btn.disabled = false;
      })
    .catch(function (err) {
        toast('Erro: ' + err.message);
        btn.disabled = false;
      });
  }
}

function inativarPecaAtual(id) {
  if (!confirm('Remover essa peça do catálogo ativo?')) return;
  api('inativarPeca', { idPeca: id })
    .then(function () {
      toast('Peça removida do catálogo');
      fecharModalPeca();
      carregarCatalogo();
    })
    .catch(function (err) { toast('Erro: ' + err.message); });
}

// ---------------------------------------------------------
// ALERTAS DE ESTOQUE — 3 níveis (atenção / mínimo / zerado), cada um com um
// botão pra já abrir a solicitação pré-preenchida, pra facilitar a vida.
// ---------------------------------------------------------
function calcularAlertasEstoque() {
  const alertas = [];
  CATALOGO.forEach(p => {
    if (p.Ativo === false) return;
    const atual = Number(p['Estoque_Atual'] || 0);
    const minimo = Number(p['Estoque_Minimo'] || 0);

    let tier = null;
    if (atual <= 0) tier = 'zerado';
    else if (atual <= minimo) tier = 'minimo';
    else if (atual <= minimo + 3) tier = 'atencao';
    if (!tier) return;

    const espaco = espacoDisponivelParaPedir(p); // null se sem Estoque Máximo
    const alvo = espaco !== null ? Number(p['Estoque_Maximo']) : minimo * 2;
    let sugerida = Math.max(1, alvo - atual);
    if (espaco !== null) sugerida = Math.min(sugerida, espaco);

    alertas.push({ peca: p, tier: tier, atual: atual, minimo: minimo, sugerida: sugerida });
  });
  const ordem = { zerado: 0, minimo: 1, atencao: 2 };
  alertas.sort((a, b) => ordem[a.tier] - ordem[b.tier]);
  return alertas;
}

function renderPainelAlertas() {
  const alertas = calcularAlertasEstoque();
  const btn = document.getElementById('btn-alertas-estoque');
  const painel = document.getElementById('painel-alertas-estoque');

  if (!alertas.length) {
    btn.classList.add('hidden');
    painel.classList.add('hidden');
    painel.innerHTML = '';
    return;
  }

  btn.classList.remove('hidden');
  document.getElementById('texto-alertas-estoque').textContent =
    alertas.length + ' peça' + (alertas.length > 1 ? 's precisam' : ' precisa') + ' de atenção no estoque — toque pra ver';

  painel.innerHTML = alertas.map(a => {
    let msg;
    if (a.tier === 'zerado') msg = 'Estoque zerado — mínimo cadastrado: ' + a.minimo;
    else if (a.tier === 'minimo') msg = 'No estoque mínimo — restam ' + a.atual + ' (mínimo: ' + a.minimo + ')';
    else msg = 'Perto do mínimo — restam ' + a.atual + ' (mínimo: ' + a.minimo + ')';

    return '<div class="alerta-estoque-card tier-' + a.tier + '">' +
      '<div class="alerta-estoque-info">' +
      '<div class="alerta-estoque-nome">' + esc(a.peca.Nome_Peca) + '</div>' +
      '<div class="alerta-estoque-msg">' + esc(msg) + '</div>' +
      '</div>' +
      '<button type="button" class="alerta-estoque-btn" onclick="solicitarMaisAlerta(\'' + esc(a.peca.ID_Peca) + '\', ' + a.sugerida + ')">Solicitar mais (' + a.sugerida + ')</button>' +
      '</div>';
  }).join('');
}

function alternarPainelAlertas() {
  document.getElementById('painel-alertas-estoque').classList.toggle('hidden');
}

function abrirModalFiltrosCatalogo() {
  montarChipsLinhaCatalogoModal();
  document.getElementById('filtro-estoque-baixo-modal').classList.toggle('selected', FILTRO_ESTOQUE_BAIXO);
  document.getElementById('modal-filtros-catalogo').classList.remove('hidden');
}

function fecharModalFiltrosCatalogo() {
  document.getElementById('modal-filtros-catalogo').classList.add('hidden');
}

function montarChipsLinhaCatalogoModal() {
  const wrap = document.getElementById('catalogo-linha-chips-modal');
  const opcoes = ['Todas'].concat(CONFIG.linhas || []);
  wrap.innerHTML = opcoes.map(l =>
    '<div class="filter-chip' + (l === FILTRO_LINHA_CATALOGO ? ' selected' : '') + '" data-linha="' + esc(l) + '">' + esc(l) + '</div>'
  ).join('');
  wrap.querySelectorAll('.filter-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      wrap.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('selected'));
      chip.classList.add('selected');
    });
  });
}

function alternarEstoqueBaixoTemp(el) {
  el.classList.toggle('selected');
}

function aplicarFiltrosCatalogo() {
  const chipLinha = document.querySelector('#catalogo-linha-chips-modal .filter-chip.selected');
  FILTRO_LINHA_CATALOGO = chipLinha ? chipLinha.dataset.linha : 'Todas';
  FILTRO_ESTOQUE_BAIXO = document.getElementById('filtro-estoque-baixo-modal').classList.contains('selected');
  localStorage.setItem('filtroLinhaCatalogo', FILTRO_LINHA_CATALOGO);
  localStorage.setItem('filtroEstoqueBaixo', String(FILTRO_ESTOQUE_BAIXO));

  const ativo = FILTRO_LINHA_CATALOGO !== 'Todas' || FILTRO_ESTOQUE_BAIXO;
  document.getElementById('badge-filtros-catalogo-ativos').classList.toggle('hidden', !ativo);

  fecharModalFiltrosCatalogo();
  renderCatalogoLista();
}

function renderCatalogoLista() {
  const termo = (document.getElementById('inp-busca-catalogo').value || '').toLowerCase();
  const wrap = document.getElementById('lista-catalogo');
  let filtradas = CATALOGO.filter(p =>
    (p.Nome_Peca || '').toLowerCase().includes(termo) ||
    String(p.ID_Peca || '').toLowerCase().includes(termo)
  );
  if (FILTRO_LINHA_CATALOGO !== 'Todas') filtradas = filtradas.filter(p => p.Linha === FILTRO_LINHA_CATALOGO);
  if (FILTRO_ESTOQUE_BAIXO) {
    filtradas = filtradas.filter(p => {
      const atual = Number(p['Estoque_Atual'] || 0);
      const minimo = Number(p['Estoque_Minimo'] || 0);
      return atual <= minimo;
    });
  }

  wrap.innerHTML = '';
  if (filtradas.length === 0) {
    wrap.innerHTML = '<div class="empty-state"><div class="big">Nada encontrado</div>' +
      (CATALOGO.length === 0 ? 'Nenhuma peça carregada ainda.' : 'Cadastre pelo botão +') + '</div>';
    return;
  }
  filtradas.forEach(p => {
    const largura = p['Largura do Produto'];
    const comprimento = p['Comprimento do Produto'];
    const estoqueAtual = Number(p['Estoque_Atual'] || 0);
    const estoqueMinimo = Number(p['Estoque_Minimo'] || 0);

    let nivel = 'ok';
    if (estoqueAtual <= 0) nivel = 'zero';
    else if (estoqueAtual <= estoqueMinimo) nivel = 'baixo';

    const imgInner = p.Imagem_URL
      ? '<img src="' + p.Imagem_URL + '" onclick="event.stopPropagation(); abrirImagemFullscreen(\'' + p.Imagem_URL.replace(/'/g, "\\'") + '\')">'
      : '<div class="thumb-lg-placeholder">▭</div>';

    const div = document.createElement('div');
    div.className = 'catalog-card-v2';
    div.innerHTML =
      '<div class="catalog-card-v2-imgwrap">' + imgInner +
      '<span class="peca-linha-badge catalog-card-v2-badge">' + esc(p.Linha || '—') + '</span>' +
      '</div>' +
      '<div class="catalog-card-v2-body">' +
      '<div class="catalog-card-id">' + esc(p.ID_Peca) + '</div>' +
      '<div class="catalog-card-name">' + esc(p.Nome_Peca) + '</div>' +
      '<div class="catalog-card-line">' + esc(p.MP || '—') + (p.Espessura ? ' · ' + esc(formatarEspessura(p.Espessura)) : '') + '</div>' +
      ((largura || comprimento) ? '<div class="catalog-card-line catalog-card-dim">Larg.: ' + esc(formatarMedida(largura) || '—') + ' × Comp.: ' + esc(formatarMedida(comprimento) || '—') + '</div>' : '') +
      (p.Servicos ? '<span class="servicos-tag">' + esc(p.Servicos) + '</span>' : '') +
      '<div class="stock-box stock-' + nivel + '">' +
      '<div class="stock-num">' + estoqueAtual + '</div>' +
      '<div class="stock-label">' + (nivel === 'zero' ? 'SEM ESTOQUE' : nivel === 'baixo' ? 'ESTOQUE BAIXO' : 'EM ESTOQUE') + '</div>' +
      '</div>' +
      '<div class="catalog-card-quick-actions">' +
      '<button type="button" class="quick-action-btn quick-entrada" onclick="event.stopPropagation(); abrirMovimentoRapido(\'' + p.ID_Peca + '\', \'entrada\')">+ Entrada</button>' +
      '<button type="button" class="quick-action-btn quick-saida" onclick="event.stopPropagation(); abrirMovimentoRapido(\'' + p.ID_Peca + '\', \'saida\')">− Saída</button>' +
      '</div>' +
      '</div>';
    div.addEventListener('click', () => editarPecaExistente(p.ID_Peca));
    wrap.appendChild(div);
  });
}

// ---------------------------------------------------------
// FOTOS (comum: solicitação e peça)
// ---------------------------------------------------------
// Reduz uma imagem base64 pra no máximo 1600px no maior lado.
// Isso mantém qualidade suficiente pra referência e evita payload gigante.
function redimensionarBase64(base64, maxDim, callback) {
  const img = new Image();
  img.onload = function () {
    let w = img.width, h = img.height;
    if (w <= maxDim && h <= maxDim) { callback(base64); return; }
    if (w >= h) { h = Math.round(h * maxDim / w); w = maxDim; }
    else { w = Math.round(w * maxDim / h); h = maxDim; }
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
    callback(canvas.toDataURL('image/jpeg', 0.85));
  };
  img.onerror = function () { callback(base64); };
  img.src = base64;
}

function handleFotoChange(e, alvo) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function (ev) {
    redimensionarBase64(ev.target.result, 1600, function (reduzida) {
      if (alvo === 'etiqueta') {
        PECA_IMAGEM_ETIQUETA_BASE64 = reduzida;
        const img = document.getElementById('peca-imagem-etiqueta-preview');
        img.src = reduzida;
        img.style.display = 'block';
      } else {
        PECA_IMAGEM_BASE64 = reduzida;
        const img = document.getElementById('peca-imagem-preview');
        img.src = reduzida;
        img.style.display = 'block';
      }
    });
  };
  reader.readAsDataURL(file);
}

// ---------------------------------------------------------
// NOVA SOLICITAÇÃO — formato de assistente, uma pergunta por vez
// ---------------------------------------------------------
let ITENS_SOLICITACAO = [];
let PROXIMO_ITEM_UID = 1;
let WIZARD_ETAPA = 'nome';
let WIZARD_ITEM_ATUAL = null;
let WIZARD_SOLICITANTE = '';
let WIZARD_OBSERVACAO_GERAL = '';

function novoItemVazio() {
  return { uid: 'it' + (PROXIMO_ITEM_UID++), peca: null, quantidade: 1, urgente: false, fotos: [], observacao: '' };
}

function acharItemSolicitacao(uid) {
  return ITENS_SOLICITACAO.find(it => it.uid === uid);
}

function abrirFormNova() {
  ITENS_SOLICITACAO = [];
  WIZARD_SOLICITANTE = '';
  WIZARD_OBSERVACAO_GERAL = '';
  WIZARD_ITEM_ATUAL = null;
  document.getElementById('btn-abrir-nova').classList.add('hidden');
  document.getElementById('wizard-nova').classList.remove('hidden');
  irParaEtapa('nome');
}

function fecharFormNova() {
  document.getElementById('wizard-nova').classList.add('hidden');
  document.getElementById('btn-abrir-nova').classList.remove('hidden');
}

function cancelarWizard() {
  if (!confirm('Cancelar essa solicitação? Nada será enviado.')) return;
  fecharFormNova();
}

// Usado pelo botão "Solicitar mais" dos alertas de estoque (Catálogo) — já
// chega com a peça e a quantidade sugerida escolhidas, só falta confirmar
// o nome e passar pelas outras etapas normalmente.
function solicitarMaisAlerta(idPeca, quantidadeSugerida) {
  const peca = CATALOGO.find(p => p.ID_Peca === idPeca);
  if (!peca) { toast('Peça não encontrada'); return; }

  trocarView('nova');
  WIZARD_OBSERVACAO_GERAL = '';

  const item = novoItemVazio();
  item.peca = peca;
  item.quantidade = Math.max(1, quantidadeSugerida);
  item.urgente = (calcularAlertasEstoque().find(a => a.peca.ID_Peca === idPeca) || {}).tier === 'zerado';
  ITENS_SOLICITACAO = [item];
  WIZARD_ITEM_ATUAL = item;

  document.getElementById('btn-abrir-nova').classList.add('hidden');
  document.getElementById('wizard-nova').classList.remove('hidden');
  irParaEtapa('nome');
  toast('Peça pré-selecionada — confirme seu nome pra continuar');
}

// ---- navegação entre as etapas ----
function irParaEtapa(etapa) {
  WIZARD_ETAPA = etapa;
  renderWizardEtapa();
}

function voltarWizard() {
  const mapaVolta = {
    'buscar-peca': function () {
      const idx = ITENS_SOLICITACAO.indexOf(WIZARD_ITEM_ATUAL);
      if (idx !== -1) ITENS_SOLICITACAO.splice(idx, 1);
      if (idx <= 0) { irParaEtapa('nome'); return; }
      WIZARD_ITEM_ATUAL = ITENS_SOLICITACAO[idx - 1];
      irParaEtapa('mais-peca');
    },
    'quantidade': function () { irParaEtapa('buscar-peca'); },
    'urgente': function () { irParaEtapa('quantidade'); },
    'fotos': function () { irParaEtapa('urgente'); },
    'observacao-item': function () { irParaEtapa('fotos'); },
    'mais-peca': function () { irParaEtapa('observacao-item'); },
    'observacao-geral': function () {
      WIZARD_ITEM_ATUAL = ITENS_SOLICITACAO[ITENS_SOLICITACAO.length - 1];
      irParaEtapa('mais-peca');
    },
    'resumo': function () { irParaEtapa('observacao-geral'); },
  };
  if (mapaVolta[WIZARD_ETAPA]) mapaVolta[WIZARD_ETAPA]();
}

function numeroDoItemAtual() {
  return ITENS_SOLICITACAO.indexOf(WIZARD_ITEM_ATUAL) + 1;
}

function montarProgressoWizard() {
  const rotulos = {
    'nome': 'Quem está solicitando',
    'buscar-peca': 'Peça ' + numeroDoItemAtual(),
    'quantidade': 'Peça ' + numeroDoItemAtual(),
    'urgente': 'Peça ' + numeroDoItemAtual(),
    'fotos': 'Peça ' + numeroDoItemAtual(),
    'observacao-item': 'Peça ' + numeroDoItemAtual(),
    'mais-peca': 'Peça ' + numeroDoItemAtual(),
    'observacao-geral': 'Últimos detalhes',
    'resumo': 'Confirmação',
  };
  return esc(rotulos[WIZARD_ETAPA] || '');
}

function renderWizardEtapa() {
  document.getElementById('wizard-progresso').textContent = montarProgressoWizard();
  const el = document.getElementById('wizard-conteudo');
  const construtores = {
    'nome': telaNomeWizard,
    'buscar-peca': telaBuscarPecaWizard,
    'quantidade': telaQuantidadeWizard,
    'urgente': telaUrgenteWizard,
    'fotos': telaFotosWizard,
    'observacao-item': telaObservacaoItemWizard,
    'mais-peca': telaMaisPecaWizard,
    'observacao-geral': telaObservacaoGeralWizard,
    'resumo': telaResumoWizard,
  };
  el.innerHTML = construtores[WIZARD_ETAPA]();
  if (WIZARD_ETAPA === 'fotos') wireFotosInputsWizard();
  const primeiroInput = el.querySelector('input, select, textarea');
  if (primeiroInput && (WIZARD_ETAPA === 'quantidade' || WIZARD_ETAPA === 'observacao-item' || WIZARD_ETAPA === 'observacao-geral')) {
    primeiroInput.focus();
  }
}

// ---- etapa: nome ----
function telaNomeWizard() {
  const lista = CONFIG.solicitantes || [];
  const salvo = localStorage.getItem('nomeUsuario');
  const padrao = (salvo && lista.indexOf(salvo) !== -1) ? salvo : lista[0];
  const opcoes = lista.map(n => '<option value="' + esc(n) + '"' + (n === padrao ? ' selected' : '') + '>' + esc(n) + '</option>').join('');
  return '<div class="wizard-card">' +
    '<div class="wizard-pergunta">Quem está solicitando?</div>' +
    '<select id="wizard-nome-select" class="wizard-select">' + opcoes + '</select>' +
    '<button type="button" class="btn-primary" onclick="confirmarNomeWizard()">Continuar</button>' +
    '</div>';
}

function confirmarNomeWizard() {
  WIZARD_SOLICITANTE = document.getElementById('wizard-nome-select').value;
  localStorage.setItem('nomeUsuario', WIZARD_SOLICITANTE);
  if (ITENS_SOLICITACAO.length && ITENS_SOLICITACAO[0].peca) {
    WIZARD_ITEM_ATUAL = ITENS_SOLICITACAO[0];
    irParaEtapa('quantidade');
    return;
  }
  const item = novoItemVazio();
  ITENS_SOLICITACAO.push(item);
  WIZARD_ITEM_ATUAL = item;
  irParaEtapa('buscar-peca');
}

// ---- etapa: buscar peça ----
function telaBuscarPecaWizard() {
  const numero = numeroDoItemAtual();
  return '<div class="wizard-card">' +
    '<button type="button" class="wizard-voltar" onclick="voltarWizard()">‹ Voltar</button>' +
    '<div class="wizard-pergunta">Peça ' + numero + ' — qual peça você precisa?</div>' +
    '<button type="button" class="btn-primary" onclick="abrirPickerWizard()">🔍 Toque para buscar a peça</button>' +
    '<button type="button" class="btn-secondary btn-solto" onclick="abrirScanWizard()">📷 Ou escanear o QR da etiqueta</button>' +
    '</div>';
}

function abrirPickerWizard() {
  abrirPickerPeca(function (p) {
    if (!aceitarPecaNoLimite(p)) return;
    WIZARD_ITEM_ATUAL.peca = p;
    aplicarMaximoNoItem(WIZARD_ITEM_ATUAL);
    irParaEtapa('quantidade');
  });
}

function abrirScanWizard() {
  abrirScanQR(function (p) {
    if (!aceitarPecaNoLimite(p)) return;
    WIZARD_ITEM_ATUAL.peca = p;
    aplicarMaximoNoItem(WIZARD_ITEM_ATUAL);
    irParaEtapa('quantidade');
  });
}

// ---- etapa: quantidade ----
function telaQuantidadeWizard() {
  const p = WIZARD_ITEM_ATUAL.peca;
  const espaco = espacoDisponivelParaPedir(p);
  return '<div class="wizard-card">' +
    '<button type="button" class="wizard-voltar" onclick="voltarWizard()">‹ Voltar</button>' +
    '<div class="wizard-pergunta">Quantidade</div>' +
    '<div class="item-id-confirm">ID: ' + esc(p.ID_Peca) + '</div>' +
    '<div class="wizard-peca-nome">' + esc(p.Nome_Peca) + '</div>' +
    (p.Imagem_URL ? '<div style="text-align:center;"><img src="' + p.Imagem_URL + '" class="item-imagem-confirm" onclick="abrirImagemFullscreen(\'' + p.Imagem_URL.replace(/'/g, "\\'") + '\')"></div>' : '') +
    (espaco !== null ? '<div class="wizard-dica">Cabe pedir até: ' + esc(espaco) + '</div>' : '') +
    '<div class="wizard-stepper-row">' +
    '<button type="button" class="wizard-stepper-btn" onclick="ajustarQtdWizard(-1)">−</button>' +
    '<input type="text" inputmode="numeric" pattern="[0-9]*" id="wizard-qtd-input" value="' + WIZARD_ITEM_ATUAL.quantidade + '" class="wizard-input-grande">' +
    '<button type="button" class="wizard-stepper-btn" onclick="ajustarQtdWizard(1)">+</button>' +
    '</div>' +
    '<button type="button" class="btn-primary" onclick="confirmarQuantidadeWizard()">Continuar</button>' +
    '</div>';
}

function ajustarQtdWizard(delta) {
  const el = document.getElementById('wizard-qtd-input');
  const atual = Math.max(1, Number(el.value) || 1);
  el.value = Math.max(1, atual + delta);
  validarMaximoItem(el, WIZARD_ITEM_ATUAL.uid);
}

function confirmarQuantidadeWizard() {
  const el = document.getElementById('wizard-qtd-input');
  limparZerosQuantidade(el, 1);
  validarMaximoItem(el, WIZARD_ITEM_ATUAL.uid);
  WIZARD_ITEM_ATUAL.quantidade = Math.max(1, Number(el.value) || 1);
  irParaEtapa('urgente');
}

// ---- etapa: urgente ----
function telaUrgenteWizard() {
  return '<div class="wizard-card">' +
    '<button type="button" class="wizard-voltar" onclick="voltarWizard()">‹ Voltar</button>' +
    '<div class="wizard-pergunta">Essa peça é urgente?</div>' +
    '<div class="wizard-simnao">' +
    '<button type="button" class="wizard-btn-urgente" onclick="responderUrgenteWizard(true)">🔴 Sim, urgente</button>' +
    '<button type="button" class="btn-secondary btn-solto" onclick="responderUrgenteWizard(false)">Não</button>' +
    '</div>' +
    '</div>';
}

function responderUrgenteWizard(valor) {
  WIZARD_ITEM_ATUAL.urgente = valor;
  irParaEtapa('fotos');
}

// ---- etapa: fotos ----
function telaFotosWizard() {
  const fotosHtml = WIZARD_ITEM_ATUAL.fotos.map((foto, fi) =>
    '<div class="photo-preview-item"><img src="' + foto + '">' +
    '<button type="button" class="photo-preview-remove" onclick="removerFotoWizard(' + fi + ')">×</button></div>'
  ).join('');
  return '<div class="wizard-card">' +
    '<button type="button" class="wizard-voltar" onclick="voltarWizard()">‹ Voltar</button>' +
    '<div class="wizard-pergunta">Fotos desta peça (opcional)</div>' +
    '<div class="photo-buttons-row">' +
    '<div class="photo-input"><input type="file" accept="image/*" capture="environment" id="wizard-foto-camera"> 📷 Tirar foto</div>' +
    '<div class="photo-input"><input type="file" accept="image/*" multiple id="wizard-foto-arquivo"> 🖼️ Escolher arquivo(s)</div>' +
    '</div>' +
    (fotosHtml ? '<div class="photos-preview-row">' + fotosHtml + '</div>' : '') +
    '<button type="button" class="btn-primary" onclick="irParaEtapa(\'observacao-item\')">Continuar</button>' +
    '</div>';
}

function wireFotosInputsWizard() {
  const handler = function (e) {
    const files = Array.from(e.target.files || []);
    let restantes = files.length;
    if (!restantes) return;
    files.forEach(file => {
      const reader = new FileReader();
      reader.onload = function (ev) {
        redimensionarBase64(ev.target.result, 1600, function (reduzida) {
          WIZARD_ITEM_ATUAL.fotos.push(reduzida);
          restantes--;
          if (restantes === 0) renderWizardEtapa();
        });
      };
      reader.readAsDataURL(file);
    });
  };
  const cam = document.getElementById('wizard-foto-camera');
  const arq = document.getElementById('wizard-foto-arquivo');
  if (cam) cam.addEventListener('change', handler);
  if (arq) arq.addEventListener('change', handler);
}

function removerFotoWizard(idx) {
  WIZARD_ITEM_ATUAL.fotos.splice(idx, 1);
  renderWizardEtapa();
}

// ---- etapa: observação do item ----
function telaObservacaoItemWizard() {
  return '<div class="wizard-card">' +
    '<button type="button" class="wizard-voltar" onclick="voltarWizard()">‹ Voltar</button>' +
    '<div class="wizard-pergunta">Observação desta peça (opcional)</div>' +
    '<textarea id="wizard-obs-item" placeholder="Opcional...">' + esc(WIZARD_ITEM_ATUAL.observacao) + '</textarea>' +
    '<button type="button" class="btn-primary" onclick="confirmarObsItemWizard()">Continuar</button>' +
    '</div>';
}

function confirmarObsItemWizard() {
  WIZARD_ITEM_ATUAL.observacao = document.getElementById('wizard-obs-item').value.trim();
  irParaEtapa('mais-peca');
}

// ---- etapa: mais peça? ----
function telaMaisPecaWizard() {
  return '<div class="wizard-card">' +
    '<button type="button" class="wizard-voltar" onclick="voltarWizard()">‹ Voltar</button>' +
    '<div class="wizard-pergunta">Quer adicionar outra peça?</div>' +
    '<div class="wizard-simnao">' +
    '<button type="button" class="btn-primary" onclick="responderMaisPecaWizard(true)">+ Sim, adicionar outra</button>' +
    '<button type="button" class="btn-secondary btn-solto" onclick="responderMaisPecaWizard(false)">Não, continuar</button>' +
    '</div>' +
    '</div>';
}

function responderMaisPecaWizard(sim) {
  if (sim) {
    const item = novoItemVazio();
    ITENS_SOLICITACAO.push(item);
    WIZARD_ITEM_ATUAL = item;
    irParaEtapa('buscar-peca');
  } else {
    irParaEtapa('observacao-geral');
  }
}

// ---- etapa: observação geral ----
function telaObservacaoGeralWizard() {
  return '<div class="wizard-card">' +
    '<button type="button" class="wizard-voltar" onclick="voltarWizard()">‹ Voltar</button>' +
    '<div class="wizard-pergunta">Observação geral (opcional)</div>' +
    '<div class="wizard-dica">Vale pra solicitação inteira, não só pra uma peça</div>' +
    '<textarea id="wizard-obs-geral" placeholder="Opcional...">' + esc(WIZARD_OBSERVACAO_GERAL) + '</textarea>' +
    '<button type="button" class="btn-primary" onclick="confirmarObsGeralWizard()">Continuar</button>' +
    '</div>';
}

function confirmarObsGeralWizard() {
  WIZARD_OBSERVACAO_GERAL = document.getElementById('wizard-obs-geral').value.trim();
  irParaEtapa('resumo');
}

// ---- etapa: resumo final ----
function telaResumoWizard() {
  const itensHtml = ITENS_SOLICITACAO.map((item, idx) => {
    const p = item.peca;
    return '<div class="wizard-resumo-item">' +
      '<div class="wizard-resumo-item-head">' +
      '<span>' + (idx + 1) + '. ' + esc(p.Nome_Peca) + '</span>' +
      (item.urgente ? '<span class="urgent-badge">Urgente</span>' : '') +
      '</div>' +
      '<div class="wizard-resumo-item-sub">ID: ' + esc(p.ID_Peca) + ' · Qtd: ' + esc(item.quantidade) + '</div>' +
      (p.Imagem_URL ? '<img src="' + p.Imagem_URL + '" class="wizard-resumo-item-foto" onclick="abrirImagemFullscreen(\'' + p.Imagem_URL.replace(/'/g, "\\'") + '\')">' : '') +
      (item.observacao ? '<div class="wizard-resumo-item-obs">' + esc(item.observacao) + '</div>' : '') +
      '</div>';
  }).join('');

  return '<div class="wizard-card">' +
    '<button type="button" class="wizard-voltar" onclick="voltarWizard()">‹ Voltar</button>' +
    '<div class="wizard-pergunta">Confira sua solicitação</div>' +
    '<div class="wizard-resumo-linha"><b>Solicitante:</b> ' + esc(WIZARD_SOLICITANTE) + '</div>' +
    itensHtml +
    (WIZARD_OBSERVACAO_GERAL ? '<div class="wizard-resumo-linha"><b>Observação geral:</b> ' + esc(WIZARD_OBSERVACAO_GERAL) + '</div>' : '') +
    '<button type="button" class="btn-primary" id="wizard-btn-enviar" onclick="enviarSolicitacao()">Enviar solicitação</button>' +
    '<button type="button" class="btn-secondary" onclick="cancelarWizard()">Cancelar</button>' +
    '</div>';
}

async function enviarSolicitacao() {
  for (const item of ITENS_SOLICITACAO) {
    if (!item.peca) { toast('Selecione a peça em todas as linhas'); return; }
    if (!item.quantidade || item.quantidade <= 0) { toast('Quantidade inválida em alguma peça'); return; }
    const espaco = espacoDisponivelParaPedir(item.peca);
    if (espaco !== null && item.quantidade > espaco) {
      toast('"' + item.peca.Nome_Peca + '": pedindo ' + item.quantidade + ', mas só cabem mais ' + espaco + ' sem passar do estoque máximo (' + item.peca.Estoque_Maximo + ').');
      return;
    }
  }

  const pedidoId = 'PED' + Date.now();
  const btn = document.getElementById('wizard-btn-enviar');
  btn.disabled = true;

  try {
    for (let i = 0; i < ITENS_SOLICITACAO.length; i++) {
      const item = ITENS_SOLICITACAO[i];
      btn.innerHTML = '<span class="spinner"></span> Enviando ' + (i + 1) + '/' + ITENS_SOLICITACAO.length + '...';
      const obsCombinada = [WIZARD_OBSERVACAO_GERAL, item.observacao].filter(Boolean).join(' | ');
      await api('salvarSolicitacao', {
        dados: {
          pedidoId: pedidoId,
          solicitante: WIZARD_SOLICITANTE,
          idPeca: item.peca.ID_Peca,
          nomePeca: item.peca.Nome_Peca,
          quantidade: item.quantidade,
          observacao: obsCombinada,
          urgente: item.urgente,
          fotos: item.fotos
        }
      });
    }
    toast('Solicitação enviada! (' + ITENS_SOLICITACAO.length + (ITENS_SOLICITACAO.length > 1 ? ' peças)' : ' peça)'));
    fecharFormNova();
    trocarView('painel');
  } catch (err) {
    toast('Erro ao enviar: ' + err.message);
    btn.disabled = false;
    btn.textContent = 'Enviar solicitação';
  }
}

// ---- validação de Estoque Máximo (capacidade) ----
function espacoDisponivelParaPedir(peca) {
  if (!peca) return null;
  const max = Number(peca.Estoque_Maximo);
  if (peca.Estoque_Maximo === '' || peca.Estoque_Maximo === undefined || isNaN(max)) return null;
  const atual = Number(peca['Estoque_Atual'] || 0);
  return Math.max(0, max - atual);
}

function validarMaximoItem(el, uid) {
  const item = acharItemSolicitacao(uid);
  if (!item || !item.peca) return;
  const espaco = espacoDisponivelParaPedir(item.peca);
  if (espaco === null) return;
  const atual = Number(el.value) || 1;
  if (atual > espaco) {
    el.value = Math.max(1, espaco);
    if (espaco <= 0) {
      toast('"' + item.peca.Nome_Peca + '" já está no estoque máximo (' + item.peca.Estoque_Maximo + ') — não é possível pedir mais agora.');
    } else {
      toast('Só é possível pedir mais ' + espaco + ' de "' + item.peca.Nome_Peca + '" — estoque atual (' + (item.peca['Estoque_Atual'] || 0) + ') + isso já bate no máximo (' + item.peca.Estoque_Maximo + ').');
    }
  }
}

// Se a peça já está no estoque máximo (ou acima), barra a seleção e explica
// o motivo — não dá nem pra escolher essa peça na solicitação nesse caso.
function aceitarPecaNoLimite(peca) {
  const espaco = espacoDisponivelParaPedir(peca);
  if (espaco !== null && espaco <= 0) {
    alert('Não é possível solicitar "' + peca.Nome_Peca + '" agora.\n\n' +
      'Estoque atual: ' + (peca['Estoque_Atual'] || 0) + '\n' +
      'Estoque máximo cadastrado: ' + peca.Estoque_Maximo + '\n\n' +
      'O estoque dessa peça já está no limite máximo — pedir mais faria passar da capacidade cadastrada.');
    return false;
  }
  return true;
}

// Reaplica o teto de Estoque Máximo quando a peça do item muda — se a
// quantidade que já estava digitada passar do que ainda cabe, ajusta sozinho.
function aplicarMaximoNoItem(item) {
  if (!item.peca) return;
  const espaco = espacoDisponivelParaPedir(item.peca);
  if (espaco === null) return;
  if (item.quantidade > espaco) {
    item.quantidade = Math.max(1, espaco);
    toast('Quantidade ajustada pra ' + item.quantidade + ' — é o máximo que ainda cabe pra essa peça sem passar da capacidade.');
  }
}


// ---------------------------------------------------------
// PAINEL — agrupado por PEDIDO (vários itens juntos)
// ---------------------------------------------------------
const STATUS_ORDEM = ['Solicitado', 'Em produção', 'Pronto', 'Entregue'];
let PEDIDOS_CACHE = [];
let PEDIDO_DETALHE_ATUAL = null;
let MODO_ADMIN = localStorage.getItem('modoAdmin') === 'true';

function carregarSolicitacoes() {
  // Busca tudo (sem filtrar por status no servidor) — o filtro por status
  // agora é aplicado no nível do PEDIDO depois de agrupar os itens.
  api('getSolicitacoes', {})
    .then(function (lista) {
      SOLICITACOES = lista || [];
      renderPainel();
      renderAlertasProgramacao();
    })
    .catch(function (err) {
      document.getElementById('lista-painel').innerHTML =
        '<div class="empty-state"><div class="big">Erro ao carregar</div>' + esc(err.message) + '</div>';
      toast('Erro ao carregar painel: ' + err.message);
    });
}

function abrirModalFiltrosPainel() {
  document.querySelectorAll('#periodo-filter-row-modal .filter-chip').forEach(c =>
    c.classList.toggle('selected', c.dataset.periodo === FILTRO_PERIODO));
  document.querySelectorAll('#status-filter-row-modal .filter-chip').forEach(c =>
    c.classList.toggle('selected', c.dataset.status === FILTRO_STATUS));
  document.getElementById('modal-filtros-painel').classList.remove('hidden');
}

function fecharModalFiltrosPainel() {
  document.getElementById('modal-filtros-painel').classList.add('hidden');
}

function selecionarPeriodoTemp(periodo, el) {
  document.querySelectorAll('#periodo-filter-row-modal .filter-chip').forEach(c => c.classList.remove('selected'));
  el.classList.add('selected');
}

function selecionarStatusTemp(status, el) {
  document.querySelectorAll('#status-filter-row-modal .filter-chip').forEach(c => c.classList.remove('selected'));
  el.classList.add('selected');
}

function aplicarFiltrosPainel() {
  const chipPeriodo = document.querySelector('#periodo-filter-row-modal .filter-chip.selected');
  const chipStatus = document.querySelector('#status-filter-row-modal .filter-chip.selected');
  FILTRO_PERIODO = chipPeriodo ? chipPeriodo.dataset.periodo : 'hoje';
  FILTRO_STATUS = chipStatus ? chipStatus.dataset.status : 'Todos';
  localStorage.setItem('filtroPeriodo', FILTRO_PERIODO);
  localStorage.setItem('filtroStatus', FILTRO_STATUS);
  atualizarBadgeFiltros();
  fecharModalFiltrosPainel();
  renderPainel();
}

function atualizarBadgeFiltros() {
  const ativo = FILTRO_STATUS !== 'Todos' || FILTRO_PERIODO !== 'hoje';
  document.getElementById('badge-filtros-ativos').classList.toggle('hidden', !ativo);
}

function dataDentroDoPeriodo(dataStr, periodo) {
  if (periodo === 'todos') return true;
  const data = new Date(dataStr);
  const agora = new Date();
  if (periodo === 'hoje') return data.toDateString() === agora.toDateString();
  const dias = periodo === '7dias' ? 7 : 30;
  const limite = new Date(agora.getTime() - dias * 24 * 60 * 60 * 1000);
  return data >= limite;
}

function pecaThumbPorId(idPeca) {
  const p = CATALOGO.find(x => x.ID_Peca === idPeca);
  return p ? p.Imagem_URL : null;
}

// ---- Modo Bárbara (PIN) ----
function alternarModoAdmin() {
  if (MODO_ADMIN) {
    MODO_ADMIN = false;
    localStorage.removeItem('modoAdmin');
    toast('Modo Bárbara desativado');
    atualizarBotaoModoAdmin();
    renderPainel();
    renderAlertasProgramacao();
    return;
  }
  const pin = prompt('Digite o PIN pra liberar os controles de status:');
  if (!pin) return;
  toast('Verificando...');
  apiComRetry('verificarPin', { pin: pin })
    .then(function (ok) {
      if (ok) {
        MODO_ADMIN = true;
        localStorage.setItem('modoAdmin', 'true');
        toast('Modo Bárbara ativado');
      } else {
        toast('PIN incorreto');
      }
      atualizarBotaoModoAdmin();
      renderPainel();
      renderAlertasProgramacao();
    })
    .catch(function (err) { toast('Não consegui verificar o PIN (tentei 3x): ' + err.message); });
}

function atualizarBotaoModoAdmin() {
  const btn = document.getElementById('btn-modo-admin');
  if (!btn) return;
  btn.textContent = MODO_ADMIN ? '🔓 Modo Bárbara ativo' : '🔒 Liberar controles';
  btn.classList.toggle('ativo', MODO_ADMIN);
}

// ---- Agrupamento por pedido ----
function agruparPedidos(lista) {
  // Itens que já foram divididos (têm filhos de uma programação parcial)
  // não entram na listagem normal — quem representa a realidade atual são
  // os filhos deles. O pai fica só de registro histórico.
  const idsComFilho = new Set(lista.filter(s => s.ID_Pai).map(s => s.ID_Pai));
  const listaAtiva = lista.filter(s => !idsComFilho.has(s.ID_Solicitacao));

  const mapa = {};
  listaAtiva.forEach(s => {
    const pid = s.ID_Pedido || s.ID_Solicitacao; // registros antigos sem ID_Pedido caem sozinhos
    if (!mapa[pid]) mapa[pid] = { pedidoId: pid, solicitante: s.Solicitante, dataHora: s.Data_Hora, itens: [] };
    mapa[pid].itens.push(s);
    if (new Date(s.Data_Hora) < new Date(mapa[pid].dataHora)) mapa[pid].dataHora = s.Data_Hora;
  });
  return Object.values(mapa);
}

function statusResumoPedido(pedido) {
  let pior = STATUS_ORDEM.length - 1;
  pedido.itens.forEach(it => {
    const idx = STATUS_ORDEM.indexOf(it.Status);
    if (idx !== -1 && idx < pior) pior = idx;
  });
  return STATUS_ORDEM[pior];
}

function pedidoTemUrgente(pedido) {
  return pedido.itens.some(it => it.Urgente === true);
}

// ---------------------------------------------------------
// ALERTAS DE PROGRAMAÇÃO PARCIAL — quando um programador informa que só
// conseguiu programar parte do que foi pedido, o item se divide em 2 (o que
// foi programado + o que ainda falta), e essa divisão precisa virar 2
// etiquetas novas — a antiga não vale mais.
// ---------------------------------------------------------
function calcularAlertasProgramacao() {
  const grupos = {};
  const totais = [];
  SOLICITACOES.forEach(s => {
    if (s.Alerta_Visto === true) return;
    if (s.ID_Pai) {
      if (!grupos[s.ID_Pai]) grupos[s.ID_Pai] = [];
      grupos[s.ID_Pai].push(s);
      return;
    }
    if (s.Totalmente_Programado === true) {
      totais.push({ tipo: 'total', idSolicitacao: s.ID_Solicitacao, item: s });
    }
  });
  const divididos = Object.keys(grupos).map(idOriginal => ({ tipo: 'dividido', idOriginal: idOriginal, filhos: grupos[idOriginal] }));
  return divididos.concat(totais);
}

function renderAlertasProgramacao() {
  const btn = document.getElementById('btn-alertas-programacao');
  const painel = document.getElementById('painel-alertas-programacao');
  if (!btn || !painel) return;

  if (!MODO_ADMIN) {
    btn.classList.add('hidden');
    painel.classList.add('hidden');
    return;
  }

  const alertas = calcularAlertasProgramacao();
  if (!alertas.length) {
    btn.classList.add('hidden');
    painel.classList.add('hidden');
    painel.innerHTML = '';
    return;
  }

  btn.classList.remove('hidden');
  document.getElementById('texto-alertas-programacao').textContent =
    alertas.length + ' alerta' + (alertas.length > 1 ? 's' : '') + ' de programação — toque pra ver';

  painel.innerHTML = alertas.map(a => {
    if (a.tipo === 'dividido') {
      const filhos = a.filhos.slice().sort((x, y) => Number(y.Quantidade) - Number(x.Quantidade));
      const partes = filhos.map(f => f.Quantidade).join(' + ');
      const nomePeca = filhos[0] ? filhos[0].Nome_Peca : '';
      const pedido = filhos[0] ? filhos[0].Pedido_Perfinorte : '';
      return '<div class="alerta-prog-card">' +
        '<div class="alerta-prog-info">' +
        '<div class="alerta-prog-nome">' + esc(nomePeca) + '</div>' +
        '<div class="alerta-prog-msg">Pedido ' + esc(pedido) + ' — dividido em ' + esc(partes) + '. A etiqueta antiga não vale mais.</div>' +
        '</div>' +
        '<button type="button" class="alerta-prog-btn" onclick="imprimirEReconhecerDivisao(\'' + esc(a.idOriginal) + '\')">🖨️ Imprimir as 2 vias</button>' +
        '</div>';
    }
    const it = a.item;
    return '<div class="alerta-prog-card alerta-prog-total">' +
      '<div class="alerta-prog-info">' +
      '<div class="alerta-prog-nome">' + esc(it.Nome_Peca) + '</div>' +
      '<div class="alerta-prog-msg">Pedido ' + esc(it.Pedido_Perfinorte) + ' — programado por completo (' + esc(it.Quantidade) + '). Não precisa reimprimir nada.</div>' +
      '</div>' +
      '<button type="button" class="alerta-prog-btn alerta-prog-btn-ok" onclick="reconhecerTotalProgramado(\'' + esc(a.idSolicitacao) + '\')">✅ OK, marcar como visto</button>' +
      '</div>';
  }).join('');
}

function alternarPainelAlertasProgramacao() {
  document.getElementById('painel-alertas-programacao').classList.toggle('hidden');
}

function imprimirEReconhecerDivisao(idOriginal) {
  if (!exigirModoAdmin()) return;
  const filhos = SOLICITACOES.filter(s => s.ID_Pai === idOriginal);
  if (!filhos.length) { toast('Itens não encontrados'); return; }

  const lista = filhos.map(function (item) {
    const peca = CATALOGO.find(p => p.ID_Peca === item.ID_Peca) || {};
    return Object.assign({}, peca, {
      ID_Peca: item.ID_Peca,
      Nome_Peca: item.Nome_Peca,
      Quantidade: item.Quantidade,
      Pedido_Perfinorte: item.Pedido_Perfinorte || '',
      Item_Perfinorte: item.Item_Perfinorte || '',
      __qrTexto: 'S:' + item.ID_Solicitacao
    });
  });

  montarEImprimirEtiquetas(lista, true);

  api('marcarAlertaProgramacaoVisto', { idOriginal: idOriginal })
    .then(function () {
      filhos.forEach(f => { f.Alerta_Visto = true; });
      renderAlertasProgramacao();
    })
    .catch(function (err) { toast('As etiquetas foram impressas, mas não consegui marcar o alerta como visto: ' + err.message); });
}

function reconhecerTotalProgramado(idSolicitacao) {
  if (!exigirModoAdmin()) return;
  api('marcarAlertaTotalProgramadoVisto', { idSolicitacao: idSolicitacao })
    .then(function () {
      const it = SOLICITACOES.find(s => s.ID_Solicitacao === idSolicitacao);
      if (it) it.Alerta_Visto = true;
      toast('Marcado como visto');
      renderAlertasProgramacao();
    })
    .catch(function (err) { toast('Erro: ' + err.message); });
}

function renderPainel() {
  const wrap = document.getElementById('lista-painel');
  PEDIDOS_CACHE = agruparPedidos(SOLICITACOES);

  let pedidos = PEDIDOS_CACHE;
  if (FILTRO_STATUS !== 'Todos') {
    pedidos = pedidos.filter(pd => statusResumoPedido(pd) === FILTRO_STATUS);
  }
  pedidos = pedidos.filter(pd => dataDentroDoPeriodo(pd.dataHora, FILTRO_PERIODO));
  pedidos = pedidos.slice().sort((a, b) => {
    const ua = pedidoTemUrgente(a) ? 1 : 0;
    const ub = pedidoTemUrgente(b) ? 1 : 0;
    if (ua !== ub) return ub - ua;
    return new Date(b.dataHora) - new Date(a.dataHora);
  });

  if (pedidos.length === 0) {
    wrap.innerHTML = '<div class="empty-state"><div class="big">Nada por aqui</div>Sem pedidos nesse filtro.</div>';
    renderTabelaPainel(pedidos);
    return;
  }

  // Monta tudo como uma string só e escreve de uma vez — bem mais rápido do
  // que criar e inserir elemento por elemento, principalmente com bastante
  // pedido na lista. O clique é tratado por delegação (um listener só, fixo,
  // registrado na inicialização), então não precisa religar nada aqui.
  wrap.innerHTML = pedidos.map(pd => {
    const urgente = pedidoTemUrgente(pd);
    const statusGeral = statusResumoPedido(pd);
    const nomes = pd.itens.slice(0, 2).map(it => esc(it.Nome_Peca)).join(', ');
    const resto = pd.itens.length > 2 ? ' + ' + (pd.itens.length - 2) : '';
    return '<div class="ticket' + (urgente ? ' is-urgent' : '') + '" data-pedido-id="' + esc(pd.pedidoId) + '">' +
      '<div class="ticket-head">' +
      '<div style="min-width:0;"><div class="ticket-title">' + esc(pd.solicitante) + '</div>' +
      '<div class="ticket-sub">' + pd.itens.length + ' peça' + (pd.itens.length > 1 ? 's' : '') + ' · ' + tempoRelativo(pd.dataHora) + '</div></div>' +
      '<div class="ticket-badges">' +
      (urgente ? '<span class="urgent-badge">Urgente</span>' : '') +
      '<span class="status-badge" data-s="' + esc(statusGeral) + '">' + esc(statusGeral) + '</span>' +
      '</div></div>' +
      '<div class="ticket-perf"></div>' +
      '<div class="ticket-body"><span>' + nomes + resto + '</span></div>' +
      '</div>';
  }).join('');

  renderTabelaPainel(pedidos);
}

function renderTabelaPainel(pedidos) {
  const tbody = document.getElementById('tabela-painel-body');
  if (!tbody) return;

  if (pedidos.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="tabela-painel-vazia">Sem pedidos nesse filtro.</td></tr>';
    return;
  }

  tbody.innerHTML = pedidos.map(pd => {
    const urgente = pedidoTemUrgente(pd);
    const statusGeral = statusResumoPedido(pd);
    const nomes = pd.itens.slice(0, 3).map(it => esc(it.Nome_Peca)).join(', ');
    const resto = pd.itens.length > 3 ? ' + ' + (pd.itens.length - 3) : '';
    const pedidoPerfinorte = pd.itens.find(it => it.Pedido_Perfinorte)?.Pedido_Perfinorte || '—';
    return '<tr onclick="abrirDetalhePedido(\'' + pd.pedidoId + '\')">' +
      '<td>' + esc(pd.solicitante) + (urgente ? ' <span class="urgent-badge">Urgente</span>' : '') + '</td>' +
      '<td>' + nomes + resto + '</td>' +
      '<td>' + pd.itens.length + '</td>' +
      '<td>' + esc(pedidoPerfinorte) + '</td>' +
      '<td>' + tempoRelativo(pd.dataHora) + '</td>' +
      '<td><span class="status-badge" data-s="' + esc(statusGeral) + '">' + esc(statusGeral) + '</span></td>' +
      '</tr>';
  }).join('');
}

// ---- Detalhe do pedido (lista de itens dentro) ----
function abrirDetalhePedido(pedidoId) {
  PEDIDO_DETALHE_ATUAL = pedidoId;
  renderDetalhePedidoConteudo();
  document.getElementById('modal-detalhe-pedido').classList.remove('hidden');
}

function fecharDetalhePedido() {
  document.getElementById('modal-detalhe-pedido').classList.add('hidden');
}

// Etiquetas de RECEBIMENTO: uma por item do pedido, com a quantidade e um QR
// que identifica esse item específico (não a peça em geral). Pensada pra
// imprimir e mandar junto com a ordem de produção da Sênior — quando a peça
// chega pronta no estoque, é só escanear que já vem tudo preenchido.
function salvarPedidoPerfinorte() {
  if (!exigirModoAdmin()) return;
  const pd = PEDIDOS_CACHE.find(x => x.pedidoId === PEDIDO_DETALHE_ATUAL);
  if (!pd) return;
  const valor = document.getElementById('inp-pedido-perfinorte').value.trim();

  api('salvarPedidoPerfinorte', {
    idsSolicitacoes: pd.itens.map(it => it.ID_Solicitacao),
    numeroPedido: valor,
    usuario: 'Bárbara'
  })
    .then(function () {
      toast('Número do pedido salvo');
      pd.itens.forEach(it => { it.Pedido_Perfinorte = valor; });
    })
    .catch(function (err) { toast('Erro: ' + err.message); });
}

function imprimirEtiquetasPedidoRecebimento() {
  if (!exigirModoAdmin()) return;
  const pd = PEDIDOS_CACHE.find(x => x.pedidoId === PEDIDO_DETALHE_ATUAL);
  if (!pd) return;

  const lista = pd.itens.map(function (item) {
    const peca = CATALOGO.find(p => p.ID_Peca === item.ID_Peca) || {};
    return Object.assign({}, peca, {
      ID_Peca: item.ID_Peca,
      Nome_Peca: item.Nome_Peca,
      Quantidade: item.Quantidade,
      Pedido_Perfinorte: item.Pedido_Perfinorte || '',
      Item_Perfinorte: item.Item_Perfinorte || '',
      __qrTexto: 'S:' + item.ID_Solicitacao
    });
  });

  if (!lista.length) { toast('Nenhum item nesse pedido'); return; }
  montarEImprimirEtiquetas(lista, true);
}

function renderDetalhePedidoConteudo() {
  const pd = PEDIDOS_CACHE.find(x => x.pedidoId === PEDIDO_DETALHE_ATUAL);
  if (!pd) { fecharDetalhePedido(); return; }

  document.getElementById('pedido-detalhe-titulo').textContent = pd.solicitante;
  document.getElementById('pedido-detalhe-sub').textContent =
    pd.itens.length + ' peça' + (pd.itens.length > 1 ? 's' : '') + ' · ' + tempoRelativo(pd.dataHora);

  document.getElementById('pedido-admin-actions').style.display = MODO_ADMIN ? 'block' : 'none';
  const statusPd = statusResumoPedido(pd);
  document.getElementById('btn-etiquetas-recebimento').style.display =
    (MODO_ADMIN && (statusPd === 'Em produção' || statusPd === 'Pronto')) ? 'block' : 'none';

  const pedidoPerfinorte = pd.itens.find(it => it.Pedido_Perfinorte)?.Pedido_Perfinorte || '';
  document.getElementById('inp-pedido-perfinorte').value = pedidoPerfinorte;

  const pedidoNumeroWrap = document.getElementById('pedido-numero-visivel');
  if (pedidoPerfinorte) {
    pedidoNumeroWrap.classList.remove('hidden');
    pedidoNumeroWrap.textContent = 'Pedido Sênior: ' + pedidoPerfinorte;
  } else {
    pedidoNumeroWrap.classList.add('hidden');
  }

  renderAnexosPedido(pd, 'confirmacao', 'pedido-confirmacao-anexada', 'btn-ver-confirmacao', 'Ver Ordem de Produção', 'bloco-confirmacao');
  renderAnexosPedido(pd, 'localizacao', 'pedido-localizacao-anexada', 'btn-ver-localizacao', 'Ver Ordem de Carregamento', 'bloco-localizacao');

  document.getElementById('pedido-itens-lista').innerHTML = pd.itens.map(renderItemPedidoDetalhe).join('');
}

function renderAnexosPedido(pd, tipo, idContainer, idBotao, textoBotao, idBlocoUpload) {
  const cfg = TIPOS_ANEXO_PEDIDO[tipo];
  const raw = pd.itens.find(it => it[cfg.campoUrl])?.[cfg.campoUrl];
  const urls = raw ? String(raw).split('\n').filter(Boolean) : [];
  const temAnexo = urls.length > 0;

  // Botão de "ver" — pra todo mundo (solicitante inclusive), abre a galeria
  // em tela cheia direto. Só aparece se tiver algo pra ver.
  const btn = document.getElementById(idBotao);
  btn.classList.toggle('hidden', !temAnexo);
  btn.textContent = textoBotao;

  // A área de baixo (miniaturas com "x" pra remover) é só de gerenciamento,
  // então só faz sentido pro Modo Bárbara — já fica dentro do bloco admin.
  const wrap = document.getElementById(idContainer);
  wrap.classList.toggle('hidden', !temAnexo);
  wrap.innerHTML = temAnexo
    ? '<label style="font-size:12.5px; color:var(--ink-soft); display:block; margin-bottom:6px;">Anexado(s) — toque no × pra remover</label>' +
      '<div class="photos-preview-row">' + urls.map((url, idx) =>
        '<div class="photo-preview-item" style="width:84px; height:84px;">' +
        '<img src="' + url + '" style="cursor:zoom-in;" data-idx="' + idx + '">' +
        '<button type="button" class="photo-preview-remove" onclick="event.stopPropagation(); removerAnexoPedido(\'' + url.replace(/'/g, "\\'") + '\', \'' + tipo + '\')">×</button>' +
        '</div>'
      ).join('') + '</div>'
    : '';
  // Conecta o clique de cada miniatura via JS (não pelo onclick inline) —
  // assim não precisa colocar a lista inteira de URLs dentro do HTML, que é
  // frágil se alguma URL tiver caractere especial.
  if (temAnexo) {
    wrap.querySelectorAll('.photo-preview-item img').forEach(imgEl => {
      imgEl.addEventListener('click', () => abrirGaleriaFullscreen(urls, Number(imgEl.dataset.idx)));
    });
  }

  // A área de UPLOAD (só no Modo Bárbara) só faz sentido mostrar se ainda não
  // tem nada anexado desse tipo — depois que já tem, some sozinha; se remover
  // tudo, ela volta a aparecer automaticamente.
  const blocoUpload = document.getElementById(idBlocoUpload);
  if (blocoUpload) blocoUpload.classList.toggle('hidden', temAnexo);
}

function renderItemPedidoDetalhe(it) {
  const urgente = it.Urgente === true;
  const thumbUrl = pecaThumbPorId(it.ID_Peca);

  let html = '<div class="pedido-item-row">';

  html += '<div class="pedido-item-topo">';
  html += '<span class="catalog-card-id">' + esc(it.ID_Peca) + (it.Item_Perfinorte ? ' · Item ' + esc(it.Item_Perfinorte) : '') + '</span>';
  html += '<div class="pedido-item-badges">' +
    (urgente ? '<span class="urgent-badge">Urgente</span>' : '') +
    '<span class="status-badge" data-s="' + esc(it.Status) + '">' + esc(it.Status) + '</span>' +
    '</div>';
  html += '</div>';

  html += '<div class="pedido-item-head">';
  html += thumbHtml(thumbUrl, 'thumb');
  html += '<div class="pedido-item-nome">' + esc(it.Nome_Peca) + '</div>';
  html += '</div>';

  html += '<div class="ticket-body" style="padding:8px 0 4px;"><span>Qtd: <b>' + esc(it.Quantidade) + '</b></span></div>';
  if (it.Observacao) html += '<p style="font-size:13px; color:var(--ink-soft); margin:2px 0 6px;">' + esc(it.Observacao) + '</p>';

  if (it.Foto_URL) {
    const urls = String(it.Foto_URL).split('\n').filter(Boolean);
    html += '<div class="photos-preview-row" style="margin-bottom:6px;">' +
      urls.map(url => '<div class="photo-preview-item" style="width:64px; height:64px;">' +
        '<img src="' + url + '" style="cursor:zoom-in;" onclick="abrirImagemFullscreen(\'' + url.replace(/'/g, "\\'") + '\')"></div>').join('') +
      '</div>';
  }

  if (MODO_ADMIN) {
    html += '<div style="display:flex; gap:6px; margin:6px 0;">';
    html += '<input type="text" inputmode="numeric" pattern="[0-9]*" value="' + it.Quantidade + '" id="qtd-item-' + it.ID_Solicitacao + '" style="flex:1; padding:8px; border:1.5px solid var(--line); border-radius:8px;" onblur="limparZerosQuantidade(this, 1)">';
    html += '<button type="button" class="btn-secondary" style="width:auto; margin:0; padding:8px 12px;" onclick="salvarQtdItemPedido(\'' + it.ID_Solicitacao + '\')">Salvar qtd</button>';
    html += '</div>';
    html += '<div style="display:flex; gap:6px; margin:6px 0;">';
    html += '<input type="text" placeholder="Nº do item na Sênior" value="' + esc(it.Item_Perfinorte || '') + '" id="item-perfinorte-' + it.ID_Solicitacao + '" style="flex:1; padding:8px; border:1.5px solid var(--line); border-radius:8px;">';
    html += '<button type="button" class="btn-secondary" style="width:auto; margin:0; padding:8px 12px;" onclick="salvarItemPerfinorteUI(\'' + it.ID_Solicitacao + '\')">Salvar item</button>';
    html += '</div>';
    html += '<label class="urgent-label" style="margin-bottom:8px;">' +
      '<input type="checkbox" ' + (urgente ? 'checked' : '') + ' onchange="toggleUrgenteItemPedido(\'' + it.ID_Solicitacao + '\', this.checked)">' +
      '<span class="urgent-box">🔴 ' + (urgente ? 'Marcado como urgente' : 'Marcar como urgente') + '</span></label>';
    html += '<div class="status-actions">';
    CONFIG.status.forEach(st => {
      html += '<button type="button" class="' + (st === it.Status ? 'current' : '') + '" onclick="mudarStatusItemPedido(\'' + it.ID_Solicitacao + '\', \'' + st + '\')">' + st + '</button>';
    });
    html += '</div>';
  }

  html += '</div>';
  return html;
}

function acharItemPorId(idSolicitacao) {
  return SOLICITACOES.find(s => s.ID_Solicitacao === idSolicitacao);
}

function exigirModoAdmin() {
  if (!MODO_ADMIN) { toast('Só a Bárbara pode fazer isso. Toque em 🔒 pra liberar.'); return false; }
  return true;
}

function mudarStatusItemPedido(idSolicitacao, novoStatus) {
  if (!exigirModoAdmin()) return;
  api('atualizarStatus', { idSolicitacao: idSolicitacao, novoStatus: novoStatus, usuario: 'Bárbara' })
    .then(function () {
      toast('Status atualizado: ' + novoStatus);
      const it = acharItemPorId(idSolicitacao);
      if (it) it.Status = novoStatus;
      renderDetalhePedidoConteudo();
      renderPainel();
    })
    .catch(function (err) { toast('Erro: ' + err.message); });
}

function toggleUrgenteItemPedido(idSolicitacao, marcado) {
  if (!exigirModoAdmin()) return;
  api('atualizarUrgente', { idSolicitacao: idSolicitacao, urgente: marcado, usuario: 'Bárbara' })
    .then(function () {
      toast(marcado ? 'Marcado como urgente' : 'Urgente removido');
      const it = acharItemPorId(idSolicitacao);
      if (it) it.Urgente = marcado;
      renderDetalhePedidoConteudo();
      renderPainel();
    })
    .catch(function (err) { toast('Erro: ' + err.message); });
}

function salvarQtdItemPedido(idSolicitacao) {
  if (!exigirModoAdmin()) return;
  const novaQtd = Number(document.getElementById('qtd-item-' + idSolicitacao).value);
  if (!novaQtd || novaQtd <= 0) { toast('Quantidade inválida'); return; }
  api('atualizarQuantidade', { idSolicitacao: idSolicitacao, novaQtd: novaQtd, usuario: 'Bárbara' })
    .then(function () {
      toast('Quantidade atualizada');
      const it = acharItemPorId(idSolicitacao);
      if (it) it.Quantidade = novaQtd;
      renderDetalhePedidoConteudo();
      renderPainel();
    })
    .catch(function (err) { toast('Erro: ' + err.message); });
}

// Número do ITEM dessa peça na Sênior — sai automático na caixinha "ITEM:"
// da etiqueta de recebimento quando ela for impressa, sem precisar
// escrever a mão depois.
function salvarItemPerfinorteUI(idSolicitacao) {
  if (!exigirModoAdmin()) return;
  const valor = document.getElementById('item-perfinorte-' + idSolicitacao).value.trim();
  api('salvarItemPerfinorte', { idSolicitacao: idSolicitacao, numeroItem: valor, usuario: 'Bárbara' })
    .then(function () {
      toast('Número do item salvo');
      const it = acharItemPorId(idSolicitacao);
      if (it) it.Item_Perfinorte = valor;
    })
    .catch(function (err) { toast('Erro: ' + err.message); });
}

// ---- Confirmação por upload (print do pedido feito na Sênior) ----
// Configuração dos dois tipos de anexo que um pedido pode receber — cada um
// mexe numa coluna diferente e avança pra um status diferente.
const TIPOS_ANEXO_PEDIDO = {
  confirmacao: {
    campoUrl: 'Confirmacao_URL',
    acaoAnexar: 'anexarConfirmacaoPedido',
    acaoRemover: 'removerConfirmacaoPedido',
    statusAlvo: 'Em produção',
    mensagemSucesso: 'Confirmação anexada — pedido marcado como "Em produção"',
    seletorBotoes: '#bloco-confirmacao .photo-input, #btn-capturar-tela-confirmacao',
  },
  localizacao: {
    campoUrl: 'Localizacao_URL',
    acaoAnexar: 'anexarLocalizacaoPedido',
    acaoRemover: 'removerLocalizacaoPedido',
    statusAlvo: 'Pronto',
    mensagemSucesso: 'Localização anexada — pedido marcado como "Pronto"',
    seletorBotoes: '#bloco-localizacao .photo-input, #btn-capturar-tela-localizacao',
  },
};

function handleUploadPedido(e, tipo) {
  const files = Array.from(e.target.files || []);
  if (!files.length) return;
  if (!exigirModoAdmin()) { e.target.value = ''; return; }
  const pd = PEDIDOS_CACHE.find(x => x.pedidoId === PEDIDO_DETALHE_ATUAL);
  if (!pd) { e.target.value = ''; return; }

  const imagensBase64 = [];
  let restantes = files.length;
  files.forEach(file => {
    const reader = new FileReader();
    reader.onload = function (ev) {
      redimensionarBase64(ev.target.result, 1600, function (reduzida) {
        imagensBase64.push(reduzida);
        restantes--;
        if (restantes === 0) enviarImagensPedido(pd, imagensBase64, tipo);
      });
    };
    reader.readAsDataURL(file);
  });
  e.target.value = '';
}

function removerAnexoPedido(url, tipo) {
  const cfg = TIPOS_ANEXO_PEDIDO[tipo];
  if (!exigirModoAdmin()) return;
  const pd = PEDIDOS_CACHE.find(x => x.pedidoId === PEDIDO_DETALHE_ATUAL);
  if (!pd) return;
  if (!confirm('Remover esse anexo?')) return;

  api(cfg.acaoRemover, {
    idsSolicitacoes: pd.itens.map(it => it.ID_Solicitacao),
    urlParaRemover: url
  })
    .then(function () {
      toast('Anexo removido');
      pd.itens.forEach(it => {
        if (it[cfg.campoUrl]) {
          it[cfg.campoUrl] = String(it[cfg.campoUrl]).split('\n').filter(u => u && u !== url).join('\n');
        }
      });
      renderDetalhePedidoConteudo();
    })
    .catch(function (err) { toast('Erro: ' + err.message); });
}

function enviarImagensPedido(pd, imagensBase64, tipo) {
  const cfg = TIPOS_ANEXO_PEDIDO[tipo];
  const botoes = document.querySelectorAll(cfg.seletorBotoes);
  botoes.forEach(b => b.style.opacity = '0.6');
  api(cfg.acaoAnexar, {
    idsSolicitacoes: pd.itens.map(it => it.ID_Solicitacao),
    imagensBase64: imagensBase64,
    usuario: 'Bárbara'
  })
    .then(function (urls) {
      toast(cfg.mensagemSucesso);
      pd.itens.forEach(it => {
        it[cfg.campoUrl] = it[cfg.campoUrl] ? it[cfg.campoUrl] + '\n' + urls : urls;
        const idxAtual = STATUS_ORDEM.indexOf(it.Status);
        const idxAlvo = STATUS_ORDEM.indexOf(cfg.statusAlvo);
        if (idxAtual !== -1 && idxAtual < idxAlvo) it.Status = cfg.statusAlvo;
      });
      renderDetalhePedidoConteudo();
      renderPainel();
    })
    .catch(function (err) { toast('Erro: ' + err.message); })
    .finally(function () { botoes.forEach(b => b.style.opacity = '1'); });
}

// Captura de tela/janela — abre o seletor nativo do sistema (Windows/Mac/Chrome OS)
// e tira um "print" de um frame do que foi escolhido. Só funciona em navegador
// de computador (a API não existe em navegadores de celular).
async function capturarTelaPedido(tipo) {
  if (!exigirModoAdmin()) return;
  const pd = PEDIDOS_CACHE.find(x => x.pedidoId === PEDIDO_DETALHE_ATUAL);
  if (!pd) return;

  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    toast('Captura de tela não disponível nesse navegador/dispositivo. Use "Escolher arquivo".');
    return;
  }

  let stream;
  try {
    // "displaySurface: window" é só uma SUGESTÃO pro navegador abrir direto na aba
    // de Janela — ele ainda pode deixar a pessoa trocar pra Tela/Aba, isso é
    // controlado pelo navegador por segurança, nenhum site consegue travar isso.
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: 'window' } });
  } catch (e) {
    return; // usuário cancelou o seletor — não faz nada
  }

  const video = document.createElement('video');
  video.srcObject = stream;
  await video.play();
  // pequena espera pro primeiro frame renderizar de verdade antes de capturar
  await new Promise(r => setTimeout(r, 250));

  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);

  stream.getTracks().forEach(t => t.stop());

  const bruta = canvas.toDataURL('image/png');
  abrirCropCaptura(bruta, function (cortada) {
    redimensionarBase64(cortada, 1600, function (reduzida) {
      enviarImagensPedido(pd, [reduzida], tipo);
    });
  });
}

// ---- Ferramenta de corte (arrastar pra selecionar área, tipo Ferramenta de Captura) ----
let CROP_IMG_NATURAL = { w: 0, h: 0 };
let CROP_SELECAO = null;
let CROP_ARRASTANDO = false;
let CROP_INICIO = null;
let CROP_CALLBACK = null;

function abrirCropCaptura(dataUrl, callback) {
  CROP_CALLBACK = callback;
  CROP_SELECAO = null;
  const img = document.getElementById('crop-img');
  document.getElementById('crop-selection').style.display = 'none';
  img.onload = function () {
    CROP_IMG_NATURAL = { w: img.naturalWidth, h: img.naturalHeight };
  };
  img.src = dataUrl;
  document.getElementById('modal-crop-captura').classList.remove('hidden');
}

function cancelarCropCaptura() {
  document.getElementById('modal-crop-captura').classList.add('hidden');
  CROP_CALLBACK = null;
}

function cropPegarPonto(e) {
  if (e.touches && e.touches[0]) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
  return { x: e.clientX, y: e.clientY };
}

function cropIniciar(e) {
  const wrap = document.getElementById('crop-canvas-wrap');
  const rect = wrap.getBoundingClientRect();
  const p = cropPegarPonto(e);
  CROP_INICIO = { x: p.x - rect.left + wrap.scrollLeft, y: p.y - rect.top + wrap.scrollTop };
  CROP_ARRASTANDO = true;
}

function cropMover(e) {
  if (!CROP_ARRASTANDO) return;
  const wrap = document.getElementById('crop-canvas-wrap');
  const rect = wrap.getBoundingClientRect();
  const p = cropPegarPonto(e);
  const atual = { x: p.x - rect.left + wrap.scrollLeft, y: p.y - rect.top + wrap.scrollTop };
  const x = Math.min(CROP_INICIO.x, atual.x);
  const y = Math.min(CROP_INICIO.y, atual.y);
  const w = Math.abs(atual.x - CROP_INICIO.x);
  const h = Math.abs(atual.y - CROP_INICIO.y);
  const sel = document.getElementById('crop-selection');
  sel.style.left = x + 'px'; sel.style.top = y + 'px';
  sel.style.width = w + 'px'; sel.style.height = h + 'px';
  sel.style.display = 'block';
  CROP_SELECAO = { x, y, w, h };
}

function cropFinalizar() { CROP_ARRASTANDO = false; }

function confirmarCropCaptura() {
  const img = document.getElementById('crop-img');
  document.getElementById('modal-crop-captura').classList.add('hidden');

  // Lê o tamanho real da imagem AGORA (não depende do evento onload já ter
  // disparado — isso é o que causava imagem quebrada quando cortava rápido).
  const naturalW = img.naturalWidth;
  const naturalH = img.naturalHeight;
  if (!naturalW || !naturalH) {
    toast('A imagem ainda não carregou. Tenta de novo em 1 segundo.');
    return;
  }

  if (!CROP_SELECAO || CROP_SELECAO.w < 8 || CROP_SELECAO.h < 8) {
    // ninguém arrastou nada de verdade — usa a imagem inteira
    if (CROP_CALLBACK) CROP_CALLBACK(img.src);
    return;
  }

  const clientW = img.clientWidth || naturalW;
  const clientH = img.clientHeight || naturalH;
  const escalaX = naturalW / clientW;
  const escalaY = naturalH / clientH;

  // A seleção foi medida em relação ao CONTAINER (crop-canvas-wrap), mas o
  // corte precisa ser relativo à IMAGEM em si — se a imagem não começa
  // exatamente no canto do container (borda, centralização, etc.), o corte
  // saía deslocado do que a pessoa realmente arrastou. Corrige aqui.
  const wrap = document.getElementById('crop-canvas-wrap');
  const wrapRect = wrap.getBoundingClientRect();
  const imgRect = img.getBoundingClientRect();
  const offsetX = (imgRect.left - wrapRect.left) + wrap.scrollLeft;
  const offsetY = (imgRect.top - wrapRect.top) + wrap.scrollTop;
  const selX = Math.max(0, CROP_SELECAO.x - offsetX);
  const selY = Math.max(0, CROP_SELECAO.y - offsetY);
  const selW = Math.min(CROP_SELECAO.w, clientW - selX);
  const selH = Math.min(CROP_SELECAO.h, clientH - selY);

  const larguraFinal = Math.max(1, Math.round(selW * escalaX));
  const alturaFinal = Math.max(1, Math.round(selH * escalaY));

  const canvas = document.createElement('canvas');
  canvas.width = larguraFinal;
  canvas.height = alturaFinal;
  canvas.getContext('2d').drawImage(
    img,
    selX * escalaX, selY * escalaY, selW * escalaX, selH * escalaY,
    0, 0, larguraFinal, alturaFinal
  );
  const cortada = canvas.toDataURL('image/png');
  if (CROP_CALLBACK) CROP_CALLBACK(cortada);
}

let SCAN_STREAM = null;
let SCAN_RAF = null;
let SCAN_CANVAS = null;
let SCAN_CALLBACK = null;
let SCAN_RAPIDO_TIPO = null; // 'entrada' ou 'saida' — só usado no atalho de câmera da barra de navegação

function abrirEscolhaTipoMovimentoRapido() {
  document.getElementById('modal-escolha-tipo-scan').classList.remove('hidden');
}

function fecharEscolhaTipoMovimentoRapido() {
  document.getElementById('modal-escolha-tipo-scan').classList.add('hidden');
}

function iniciarScanRapido(tipo) {
  SCAN_RAPIDO_TIPO = tipo;
  fecharEscolhaTipoMovimentoRapido();
  abrirScanQR(function (p) {
    abrirMovimento(p.ID_Peca, { tipoInicial: SCAN_RAPIDO_TIPO });
  });
}

// ---------------------------------------------------------
// ESCANEAR QR — câmera ao vivo com fallback pra foto
// ---------------------------------------------------------
function abrirScanQR(callback) {
  SCAN_CALLBACK = callback || function (p) { abrirMovimento(p.ID_Peca); };
  document.getElementById('inp-codigo-manual').value = '';
  document.getElementById('scan-qr-status').textContent = '';
  document.getElementById('scan-fallback').style.display = 'none';
  document.getElementById('scan-video-wrap').style.display = 'block';
  document.getElementById('modal-scan-qr').classList.remove('hidden');

  if (typeof jsQR === 'undefined') {
    // Biblioteca de leitura de QR não carregou (conexão lenta, CDN fora do ar, etc).
    // Não adianta abrir a câmera se não dá pra decodificar o que ela vê.
    ativarFallbackFoto('A biblioteca de leitura de QR ainda não carregou. Verifique sua internet e recarregue a página.');
    return;
  }
  iniciarCameraScan();
}

function fecharScanQR() {
  document.getElementById('modal-scan-qr').classList.add('hidden');
  pararCameraScan();
  SCAN_RAPIDO_TIPO = null;
}

async function iniciarCameraScan() {
  // Se o browser nem sequer expõe a API, cai direto no fallback
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    ativarFallbackFoto('Este navegador não tem API de câmera.');
    return;
  }
  try {
    SCAN_STREAM = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false
    });
    const video = document.getElementById('scan-video');
    video.srcObject = SCAN_STREAM;
    await video.play();
    document.getElementById('scan-qr-status').textContent = 'Aponte a câmera para o QR code da etiqueta';
    SCAN_CANVAS = document.createElement('canvas');
    lerFrame();
  } catch (err) {
    ativarFallbackFoto('Câmera bloqueada: ' + (err.message || err.name || 'permissão negada'));
  }
}

function lerFrame() {
  const video = document.getElementById('scan-video');
  if (!SCAN_STREAM || !video || video.readyState !== video.HAVE_ENOUGH_DATA) {
    SCAN_RAF = requestAnimationFrame(lerFrame);
    return;
  }
  SCAN_CANVAS.width = video.videoWidth;
  SCAN_CANVAS.height = video.videoHeight;
  const ctx = SCAN_CANVAS.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, SCAN_CANVAS.width, SCAN_CANVAS.height);
  const imageData = ctx.getImageData(0, 0, SCAN_CANVAS.width, SCAN_CANVAS.height);
  const resultado = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'dontInvert' });
  if (resultado && resultado.data) {
    pararCameraScan();
    buscarPecaEscaneada(resultado.data);
    return;
  }
  SCAN_RAF = requestAnimationFrame(lerFrame);
}

function pararCameraScan() {
  if (SCAN_RAF) { cancelAnimationFrame(SCAN_RAF); SCAN_RAF = null; }
  if (SCAN_STREAM) {
    SCAN_STREAM.getTracks().forEach(t => t.stop());
    SCAN_STREAM = null;
  }
  const video = document.getElementById('scan-video');
  if (video) video.srcObject = null;
}

function ativarFallbackFoto(motivo) {
  document.getElementById('scan-video-wrap').style.display = 'none';
  document.getElementById('scan-fallback').style.display = 'block';
  document.getElementById('scan-qr-status').textContent = motivo || '';
}

function confirmarCodigoManual() {
  const codigo = document.getElementById('inp-codigo-manual').value.trim();
  if (!codigo) { toast('Digite ou escaneie um código'); return; }
  buscarPecaEscaneada(codigo);
}

function handleFotoQR(e) {
  const file = e.target.files[0];
  if (!file) return;
  if (typeof jsQR === 'undefined') {
    document.getElementById('scan-qr-status').textContent = 'A biblioteca de leitura de QR não carregou. Recarregue a página.';
    return;
  }
  document.getElementById('scan-qr-status').textContent = 'Lendo QR code...';
  const reader = new FileReader();
  reader.onload = function (ev) {
    const img = new Image();
    img.onload = function () {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const resultado = jsQR(imageData.data, canvas.width, canvas.height);
      if (resultado && resultado.data) {
        document.getElementById('scan-qr-status').textContent = '';
        buscarPecaEscaneada(resultado.data);
      } else {
        document.getElementById('scan-qr-status').textContent = 'Não consegui ler o QR nessa foto. Tente de novo, bem de frente e com boa luz.';
      }
    };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
  e.target.value = '';
}

async function buscarPecaEscaneada(codigo) {
  codigo = String(codigo).trim();

  // Etiqueta de RECEBIMENTO de um item de solicitação (impressa junto com o
  // pedido da Sênior) — identifica o item exato e já sabe a quantidade,
  // não é uma peça do catálogo genérica. Aceita os dois prefixos: o novo
  // "S:" (mais curto, imprime QR mais nítido) e o antigo "SOLICITACAO:"
  // (pra continuar lendo etiquetas que já foram impressas antes dessa troca).
  const prefixoNovo = 'S:';
  const prefixoAntigo = 'SOLICITACAO:';
  if (codigo.indexOf(prefixoNovo) === 0 || codigo.indexOf(prefixoAntigo) === 0) {
    const idSolicitacao = codigo.indexOf(prefixoNovo) === 0
      ? codigo.substring(prefixoNovo.length)
      : codigo.substring(prefixoAntigo.length);

    // Busca SEMPRE fresco do servidor, sem usar o SOLICITACOES em cache —
    // se uma divisão de programação aconteceu em outro aparelho/sessão
    // (ex: a tela de Programação), o cache local não saberia disso, e
    // deixaria escanear uma etiqueta já substituída como se fosse válida,
    // ou mostrar estoque desatualizado. Isso é crítico demais pra confiar
    // em cache.
    document.getElementById('scan-qr-status').textContent = 'Verificando...';
    let resultado;
    try {
      resultado = await apiComRetry('buscarSolicitacaoParaRecebimento', { idSolicitacao: idSolicitacao });
    } catch (err) {
      document.getElementById('scan-qr-status').textContent = 'Erro ao verificar: ' + err.message;
      return;
    }

    if (!resultado.encontrado) {
      document.getElementById('scan-qr-status').textContent = 'Solicitação não encontrada.';
      return;
    }
    const item = resultado.item;

    // Se esse item foi dividido depois (programação parcial), essa etiqueta
    // antiga não vale mais — a quantidade real agora está espalhada em 2
    // etiquetas novas.
    if (resultado.temFilho) {
      document.getElementById('scan-qr-status').textContent = '⚠️ Essa etiqueta foi SUBSTITUÍDA — o pedido foi dividido em novas vias. Descarte essa e use as etiquetas atualizadas.';
      return;
    }

    if (item.Status === 'Entregue' && !confirm('Esse item já foi marcado como recebido antes. Registrar a entrada de novo mesmo assim?')) {
      return;
    }
    fecharScanQR();
    if (SCAN_RAPIDO_TIPO === 'saida') {
      toast('Essa é uma etiqueta de recebimento — só faz sentido como Entrada, ajustei sozinho.');
    }
    abrirMovimento(item.ID_Peca, {
      quantidadeSugerida: item.Quantidade,
      contexto: 'Recebendo pedido de ' + item.Solicitante,
      observacaoSugerida: 'Recebimento — pedido de ' + item.Solicitante,
      idSolicitacao: item.ID_Solicitacao,
      estoqueAtualFresco: resultado.estoqueAtual
    });

    // Atualiza também o item na lista local (se existir), pra manter o
    // Painel coerente sem precisar recarregar a página inteira.
    const localIdx = SOLICITACOES.findIndex(s => s.ID_Solicitacao === item.ID_Solicitacao);
    if (localIdx !== -1) SOLICITACOES[localIdx] = Object.assign({}, SOLICITACOES[localIdx], item);
    else SOLICITACOES.push(item);

    return;
  }

  const p = CATALOGO.find(x => String(x.ID_Peca).trim().toLowerCase() === codigo.toLowerCase());
  if (!p) { document.getElementById('scan-qr-status').textContent = 'Peça "' + codigo + '" não encontrada no catálogo.'; return; }
  fecharScanQR();
  if (SCAN_CALLBACK) SCAN_CALLBACK(p);
}

// ---------------------------------------------------------
// ENTRADA / SAÍDA DE ESTOQUE
// ---------------------------------------------------------
function abrirMovimento(idPeca, opcoes) {
  const p = CATALOGO.find(x => x.ID_Peca === idPeca);
  if (!p) { toast('Peça não encontrada'); return; }
  opcoes = opcoes || {};
  // Se veio um estoque atual fresco (buscado na hora, sem cache), atualiza
  // a peça no catálogo local também — evita mostrar um valor desatualizado
  // bem na hora mais crítica, que é dar entrada de estoque.
  if (opcoes.estoqueAtualFresco !== undefined && opcoes.estoqueAtualFresco !== null) {
    p['Estoque_Atual'] = opcoes.estoqueAtualFresco;
  }
  MOVIMENTO_PECA_ATUAL = p;
  MOVIMENTO_TIPO_ATUAL = opcoes.tipoInicial === 'saida' ? 'saida' : 'entrada';
  MOVIMENTO_ID_SOLICITACAO_ATUAL = opcoes.idSolicitacao || null;

  document.getElementById('movimento-id').textContent = p.Nome_Peca;
  document.getElementById('movimento-nome').textContent = p.ID_Peca + (opcoes.contexto ? ' — ' + opcoes.contexto : '');
  document.getElementById('movimento-qtd').value = opcoes.quantidadeSugerida || 1;
  document.getElementById('movimento-obs').value = opcoes.observacaoSugerida || '';
  document.querySelectorAll('.movimento-tipo-btn').forEach(b => b.classList.toggle('selected', b.dataset.tipo === MOVIMENTO_TIPO_ATUAL));
  const btnConfirmar = document.getElementById('btn-confirmar-movimento');
  btnConfirmar.disabled = false;
  btnConfirmar.textContent = 'Confirmar';
  atualizarPreviewMovimento();
  document.getElementById('modal-movimento').classList.remove('hidden');
}

function fecharMovimento() {
  document.getElementById('modal-movimento').classList.add('hidden');
}

function abrirMovimentoRapido(idPeca, tipo) {
  abrirMovimento(idPeca);
  const btn = document.querySelector('.movimento-tipo-btn[data-tipo="' + tipo + '"]');
  if (btn) selecionarTipoMovimento(tipo, btn);
}

function selecionarTipoMovimento(tipo, el) {
  MOVIMENTO_TIPO_ATUAL = tipo;
  document.querySelectorAll('.movimento-tipo-btn').forEach(b => b.classList.remove('selected'));
  el.classList.add('selected');
  atualizarPreviewMovimento();
}

function ajustarQtdMovimento(delta) {
  const inp = document.getElementById('movimento-qtd');
  const novo = Math.max(1, (Number(inp.value) || 1) + delta);
  inp.value = novo;
  atualizarPreviewMovimento();
}

function atualizarPreviewMovimento() {
  if (!MOVIMENTO_PECA_ATUAL) return;
  const atual = Number(MOVIMENTO_PECA_ATUAL['Estoque_Atual']) || 0;
  const qtd = Math.max(1, Number(document.getElementById('movimento-qtd').value) || 1);
  const novo = MOVIMENTO_TIPO_ATUAL === 'entrada' ? atual + qtd : Math.max(0, atual - qtd);
  document.getElementById('movimento-preview').innerHTML =
    'Estoque atual: <b>' + atual + '</b> <span style="color:var(--ink-soft);">→</span> <b class="movimento-novo-' + (MOVIMENTO_TIPO_ATUAL === 'entrada' ? 'up' : 'down') + '">' + novo + '</b>';
}

function confirmarMovimento() {
  if (!MOVIMENTO_PECA_ATUAL) return;
  const qtd = Math.max(1, Number(document.getElementById('movimento-qtd').value) || 1);
  const obs = document.getElementById('movimento-obs').value.trim();
  const usuario = localStorage.getItem('nomeUsuario') || 'Desconhecido';
  const idSolicitacaoOrigem = MOVIMENTO_ID_SOLICITACAO_ATUAL;

  const btn = document.getElementById('btn-confirmar-movimento');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Salvando...';

  api('registrarMovimentoEstoque', { idPeca: MOVIMENTO_PECA_ATUAL.ID_Peca, tipo: MOVIMENTO_TIPO_ATUAL, quantidade: qtd, observacao: obs, usuario: usuario })
    .then(function (novoValor) {
      toast('Estoque atualizado: ' + novoValor);
      // Atualiza direto no array que já está na tela (é a mesma referência
      // usada pelo card do catálogo) — não precisa buscar tudo de novo no
      // servidor, então o número muda na hora, sem esperar nem dar refresh.
      MOVIMENTO_PECA_ATUAL['Estoque_Atual'] = novoValor;

      // Se essa entrada veio de escanear a etiqueta de recebimento de uma
      // solicitação, fecha o ciclo: marca aquele item como Entregue. Quando
      // todos os itens do pedido chegarem em Entregue, o pedido inteiro já
      // aparece como Entregue sozinho (o status do pedido é sempre o "pior"
      // status entre os itens dele).
      if (idSolicitacaoOrigem && MOVIMENTO_TIPO_ATUAL === 'entrada') {
        api('atualizarStatus', { idSolicitacao: idSolicitacaoOrigem, novoStatus: 'Entregue', usuario: usuario })
          .then(function () {
            const it = SOLICITACOES.find(s => s.ID_Solicitacao === idSolicitacaoOrigem);
            if (it) it.Status = 'Entregue';
            renderPainel();
          })
          .catch(function (err) { toast('Estoque entrou, mas não deu pra marcar como Entregue: ' + err.message); });
      }

      btn.disabled = false;
      btn.textContent = 'Confirmar';
      fecharMovimento();
      renderCatalogoLista();
    })
    .catch(function (err) {
      toast('Erro: ' + err.message);
      btn.disabled = false;
      btn.textContent = 'Confirmar';
    });
}

// ---------------------------------------------------------
// ETIQUETAS (impressão com QR code — janela dedicada, 107x48mm)
// ---------------------------------------------------------
const LOGO_PERFINORTE_B64 = 'data:image/png;base64,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';

function imprimirEtiquetaUnica(idPeca) {
  const p = CATALOGO.find(x => x.ID_Peca === idPeca);
  if (!p) { toast('Salve a peça antes de imprimir a etiqueta'); return; }
  montarEImprimirEtiquetas([p]);
}

function imprimirEtiquetasCatalogo() {
  const termo = (document.getElementById('inp-busca-catalogo').value || '').toLowerCase();
  let lista = CATALOGO.filter(p =>
    (p.Nome_Peca || '').toLowerCase().includes(termo) ||
    String(p.ID_Peca || '').toLowerCase().includes(termo)
  );
  if (FILTRO_LINHA_CATALOGO !== 'Todas') lista = lista.filter(p => p.Linha === FILTRO_LINHA_CATALOGO);
  if (!lista.length) { toast('Nenhuma peça pra imprimir'); return; }
  montarEImprimirEtiquetas(lista);
}

function montarEImprimirEtiquetas(lista, modoRecebimento) {
  mostrarProgressoImpressao(0, lista.length);

  const holder = document.createElement('div');
  holder.style.position = 'fixed';
  holder.style.left = '-9999px';
  document.body.appendChild(holder);
  const qr = new QRCode(holder, { width: 220, height: 220, correctLevel: QRCode.CorrectLevel.L });

  const qrDataUrls = new Array(lista.length);
  let i = 0;
  let terminou = false;

  // Watchdog: se o contador não avançar por 5s seguidos, algo travou —
  // avisa em vez de deixar girando pra sempre, e sugere um contorno imediato.
  let ultimoIVisto = -1;
  const watchdog = setInterval(function () {
    if (terminou) { clearInterval(watchdog); return; }
    if (i === ultimoIVisto) {
      clearInterval(watchdog);
      terminou = true;
      const overlay = document.getElementById('print-progress-overlay');
      if (overlay) overlay.remove();
      if (document.body.contains(holder)) document.body.removeChild(holder);
      toast('Travou gerando a etiqueta ' + (i + 1) + '/' + lista.length + '. Tenta filtrar por Linha e imprimir em grupos menores.');
    }
    ultimoIVisto = i;
  }, 5000);

  function gerarProximo() {
    if (terminou) return;
    if (i >= lista.length) {
      terminou = true;
      clearInterval(watchdog);
      document.body.removeChild(holder);
      if (modoRecebimento) {
        imprimirViaIframeRecebimento(lista, qrDataUrls);
      } else {
        imprimirViaIframe(lista, qrDataUrls);
      }
      return;
    }

    // Alguns valores de ID (ex: os que viraram data sem querer na planilha)
    // podem quebrar essa biblioteca de QR pra certos tamanhos de texto.
    // Se acontecer, pula só essa etiqueta (fica sem QR) e segue pras outras
    // em vez de travar a impressão toda.
    let falhou = false;
    try {
      qr.clear();
      qr.makeCode(String(lista[i].__qrTexto || lista[i].ID_Peca));
    } catch (e) {
      console.warn('QR falhou para', lista[i].ID_Peca, e);
      falhou = true;
    }

    if (falhou) {
      qrDataUrls[i] = '';
      i++;
      mostrarProgressoImpressao(i, lista.length);
      gerarProximo();
      return;
    }

    setTimeout(function () {
      if (terminou) return;
      const canvas = holder.querySelector('canvas');
      const img = holder.querySelector('img');
      qrDataUrls[i] = canvas ? canvas.toDataURL('image/png') : (img ? img.src : '');
      i++;
      mostrarProgressoImpressao(i, lista.length);
      gerarProximo();
    }, 0);
  }

  gerarProximo();
}

function mostrarProgressoImpressao(atual, total) {
  let overlay = document.getElementById('print-progress-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'print-progress-overlay';
    overlay.className = 'print-progress-overlay';
    overlay.innerHTML = '<div class="print-progress-box"><span class="spinner" style="border-top-color:var(--accent); border-color:rgba(0,0,0,0.15);"></span> Gerando etiquetas... <span id="print-progress-num"></span></div>';
    document.body.appendChild(overlay);
  }
  document.getElementById('print-progress-num').textContent = atual + '/' + total;
  if (atual >= total) {
    setTimeout(() => { const o = document.getElementById('print-progress-overlay'); if (o) o.remove(); }, 400);
  }
}

// Etiqueta de RECEBIMENTO — mais simples que a do catálogo: sem foto, com a
// quantidade em destaque (preto, negrito, sublinhado — impressora só tem
// tinta preta), aviso de "não colar" e marca "ESTOQUE PERFINORTE" no canto,
// pra ninguém confundir com a etiqueta que vai colada na peça.
function imprimirViaIframeRecebimento(lista, qrDataUrls) {
 try {
  const labelsHtml = lista.map((p, i) => {
    return '<div class="label-r">' +
      '<div class="label-r-body">' +
      '<div class="label-r-left">' +
      '<div class="label-r-marca">ESTOQUE<br>PERFINORTE</div>' +
      (qrDataUrls[i] ? '<img class="label-r-qr" src="' + qrDataUrls[i] + '">' : '<div class="label-r-qr-vazio">QR indisponível</div>') +
      '<div class="label-r-aviso">NÃO COLAR<br>NA PEÇA</div>' +
      '</div>' +
      '<div class="label-r-info">' +
      '<div class="label-id-box">' + esc(p.ID_Peca) + '</div>' +
      '<div class="label-r-qtd"><span class="label-r-qtd-rotulo">Qtd</span>: <span class="label-r-qtd-num">' + esc(p.Quantidade) + '</span></div>' +
      '<div class="label-r-desc">' + esc(p.Nome_Peca) + '</div>' +
      (p.Pedido_Perfinorte ? '<div class="label-r-pedido"><span class="label-r-pedido-rotulo">PEDIDO:</span><div class="label-r-pedido-num">' + esc(p.Pedido_Perfinorte) + '</div></div>' : '') +
      '</div>' +
      '<div class="label-r-right">' +
      '<div class="label-r-item-label">ITEM:</div>' +
      '<div class="label-r-item-box">' + (p.Item_Perfinorte ? esc(p.Item_Perfinorte) : '') + '</div>' +
      '<img class="label-logo label-r-logo" src="' + LOGO_PERFINORTE_B64 + '">' +
      '</div>' +
      '</div>' +
      '</div>';
  }).join('');

  const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Etiquetas de recebimento</title><style>' +
    '@page { size: 107mm 48mm; margin: 0; }' +
    '* { box-sizing: border-box; }' +
    'body { margin: 0; font-family: Arial, Helvetica, sans-serif; }' +
    '.label-r { width: 107mm; height: 48mm; padding: 2.5mm 3mm; display: flex; flex-direction: column; page-break-after: always; overflow: hidden; }' +
    '.label-r-body { display: flex; gap: 3mm; flex: 1; min-height: 0; }' +
    '.label-r-left { flex: none; width: 28mm; display: flex; flex-direction: column; align-items: center; gap: 1.2mm; }' +
    '.label-r-marca { text-align: center; align-self: center; font-size: 7pt; font-weight: 800; color: #000; letter-spacing: 0.03em; line-height: 1.2; }' +
    '.label-r-qr { width: 27mm; height: 27mm; display: block; }' +
    '.label-r-qr-vazio { width: 27mm; height: 27mm; border: 1px dashed #000; display: flex; align-items: center; justify-content: center; font-size: 6.5pt; color: #000; text-align: center; }' +
    '.label-r-aviso { margin-top: auto; background: #f2f2f2; border: 0.5mm solid #000; color: #000; font-size: 7.5pt; font-weight: 800; text-decoration: underline; text-transform: uppercase; text-align: center; padding: 1mm 2mm; border-radius: 1mm; line-height: 1.25; width: 100%; }' +
    '.label-r-info { flex: 1; min-width: 0; display: flex; flex-direction: column; }' +
    '.label-id-box { display: inline-block; align-self: flex-start; border: 0.7mm solid #000; border-radius: 1mm; padding: 0.8mm 2mm; font-size: 14pt; font-weight: 800; color: #000; line-height: 1.15; }' +
    '.label-r-qtd { font-size: 16pt; font-weight: 800; color: #000; margin-top: 1.5mm; }' +
    '.label-r-qtd-rotulo { text-decoration: underline; }' +
    '.label-r-qtd-num { text-decoration: none; }' +
    '.label-r-desc { font-size: 9.5pt; font-weight: 600; color: #000; margin-top: 1.5mm; line-height: 1.25; }' +
    '.label-r-right { flex: none; width: 20mm; display: flex; flex-direction: column; align-items: center; text-align: center; }' +
    '.label-r-item-label { font-size: 11pt; font-weight: 800; color: #000; }' +
    '.label-r-item-box { width: 17mm; height: 17mm; border: 0.7mm solid #000; border-radius: 1mm; background: #fff; margin-top: 1.5mm; display: flex; align-items: center; justify-content: center; font-size: 20pt; font-weight: 800; color: #000; }' +
    '.label-r-pedido { margin-top: auto; }' +
    '.label-r-pedido-rotulo { display: block; font-size: 8.5pt; font-weight: 800; color: #000; text-decoration: underline; }' +
    '.label-r-pedido-num { font-size: 16pt; font-weight: 800; color: #000; margin-top: 0.5mm; }' +
    '.label-r-logo { margin-top: auto; }' +
    '.label-logo { height: 6mm; display: block; filter: brightness(0); }' +
    '</style></head><body>' + labelsHtml + '</body></html>';

  let iframe = document.getElementById('print-iframe');
  if (iframe) iframe.remove();
  iframe = document.createElement('iframe');
  iframe.id = 'print-iframe';
  iframe.style.cssText = 'position:fixed; right:0; bottom:0; width:0; height:0; border:none;';
  document.body.appendChild(iframe);

  const doc = iframe.contentWindow.document;
  doc.open();
  doc.write(html);
  doc.close();

  let jaImprimiu = false;
  function dispararImpressao() {
    if (jaImprimiu) return;
    jaImprimiu = true;
    try {
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
    } catch (e) {
      toast('Erro ao abrir impressão: ' + e.message);
    }
  }
  function aguardarImagensEImprimir() {
    const imgs = Array.from(iframe.contentWindow.document.images || []);
    if (imgs.length === 0) { dispararImpressao(); return; }
    let pendentes = imgs.length;
    function marcarPronta() {
      pendentes--;
      if (pendentes <= 0) dispararImpressao();
    }
    imgs.forEach(img => {
      if (img.complete) marcarPronta();
      else {
        img.addEventListener('load', marcarPronta);
        img.addEventListener('error', marcarPronta);
      }
    });
    setTimeout(dispararImpressao, 8000);
  }
  iframe.onload = aguardarImagensEImprimir;
  setTimeout(aguardarImagensEImprimir, 300);
 } catch (e) {
  toast('Erro ao montar etiquetas: ' + e.message);
 }
}

function imprimirViaIframe(lista, qrDataUrls) {
 try {
  const largura = p => p['Largura do Produto'];
  const comprimento = p => p['Comprimento do Produto'];

  const labelsHtml = lista.map((p, i) => {
    const dims = (largura(p) || comprimento(p)) ? (esc(largura(p) || '') + '×' + esc(comprimento(p) || '') + 'mm') : '';
    // Prioriza a imagem exclusiva de etiqueta (mais "limpa" pra impressão) —
    // se a peça não tiver uma cadastrada, cai pra imagem normal do catálogo.
    const imagemParaEtiqueta = p.Imagem_Etiqueta_URL || p.Imagem_URL;
    const temFoto = !!imagemParaEtiqueta;
    return '<div class="label">' +
      '<div class="label-top">' +
      '<div class="label-qr-wrap">' +
      (qrDataUrls[i] ? '<img class="label-qr" src="' + qrDataUrls[i] + '">' : '<div class="label-qr-vazio">QR indisponível<br>pra esta peça</div>') +
      '</div>' +
      '<div class="label-specs">' +
      '<div class="label-id-box">' + esc(p.ID_Peca) + '</div>' +
      (p.Quantidade ? '<div class="label-qtd-box">Qtd: ' + esc(p.Quantidade) + '</div>' : '') +
      '<div class="label-meta-block">' +
      (p.MP ? '<div class="label-meta">MP: ' + esc(p.MP) + (p.Espessura ? ' de ' + esc(formatarEspessura(p.Espessura)) : '') + '</div>' : '') +
      (dims ? '<div class="label-meta label-meta-dims">' + dims + '</div>' : '') +
      (p.Servicos ? '<div class="label-meta">Serviço: ' + esc(p.Servicos) + '</div>' : '') +
      '</div>' +
      '</div>' +
      '<div class="label-photo-wrap">' +
      (temFoto ? '<img class="label-photo" src="' + imagemParaEtiqueta + '">' : '<div class="label-photo-vazio">sem foto</div>') +
      '</div>' +
      '</div>' +
      '<div class="label-bottom">' +
      '<div class="label-name">' + esc(p.Nome_Peca) + '</div>' +
      '<img class="label-logo" src="' + LOGO_PERFINORTE_B64 + '">' +
      '</div>' +
      '</div>';
  }).join('');

  const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Etiquetas</title><style>' +
    '@page { size: 107mm 48mm; margin: 0; }' +
    '* { box-sizing: border-box; }' +
    'body { margin: 0; font-family: Arial, Helvetica, sans-serif; }' +
    '.label { width: 107mm; height: 48mm; padding: 3mm; display: flex; flex-direction: column; gap: 1.2mm; page-break-after: always; overflow: hidden; }' +
    '.label-top { display: flex; gap: 2mm; flex: 1; min-height: 0; }' +
    '.label-qr-wrap, .label-photo-wrap { flex: none; width: 30mm; display: flex; align-items: flex-start; justify-content: center; }' +
    '.label-qr { width: 30mm; height: 30mm; display: block; }' +
    '.label-photo { width: 30mm; height: 30mm; display: block; object-fit: contain; border-radius: 2.5mm; border: 0.6mm solid #000; padding: 0.8mm; image-rendering: -webkit-optimize-contrast; image-rendering: crisp-edges; }' +
    '.label-qr-vazio, .label-photo-vazio { width: 30mm; height: 30mm; display: flex; align-items: center; justify-content: center; text-align: center; font-size: 6.5pt; color: #000; border: 1px dashed #000; border-radius: 2.5mm; box-sizing: border-box; }' +
    '.label-specs { flex: 1; min-width: 0; display: flex; flex-direction: column; }' +
    '.label-id-box { display: inline-block; align-self: flex-start; border: 0.7mm solid #000; border-radius: 1mm; padding: 0.8mm 2mm; font-size: 14pt; font-weight: 800; color: #000; line-height: 1.15; }' +
    '.label-qtd-box { display: inline-block; align-self: flex-start; background: #fff; border: 0.5mm solid #000; color: #000; border-radius: 1mm; padding: 0.8mm 2mm; font-size: 12pt; font-weight: 800; margin-top: 1mm; }' +
    '.label-meta-block { margin-top: 1.5mm; }' +
    '.label-meta { font-size: 7.8pt; color: #000; font-weight: 600; margin-top: 0.8mm; line-height: 1.3; }' +
    '.label-meta-dims { font-size: 10.5pt; font-weight: 800; }' +
    '.label-bottom { display: flex; align-items: flex-end; gap: 2mm; flex: none; }' +
    '.label-name { flex: 1; min-width: 0; font-size: 9pt; font-weight: 700; color: #000; line-height: 1.2; max-height: 8.8mm; overflow: hidden; }' +
    '.label-logo { height: 6mm; flex: none; display: block; filter: brightness(0); }' +
    '</style></head><body>' + labelsHtml + '</body></html>';

  // iframe escondido na PRÓPRIA aba — ao contrário de window.open(), nunca fica
  // em segundo plano, então o navegador (Safari no iPhone principalmente) não
  // pausa a geração no meio do caminho.
  let iframe = document.getElementById('print-iframe');
  if (iframe) iframe.remove();
  iframe = document.createElement('iframe');
  iframe.id = 'print-iframe';
  iframe.style.cssText = 'position:fixed; right:0; bottom:0; width:0; height:0; border:none;';
  document.body.appendChild(iframe);

  const doc = iframe.contentWindow.document;
  doc.open();
  doc.write(html);
  doc.close();

  // onload de iframe preenchido via document.write() nem sempre dispara de
  // forma confiável — por segurança, tenta imprimir tanto pelo onload quanto
  // por um temporizador de reforço, o que disparar primeiro vence.
  let jaImprimiu = false;
  function dispararImpressao() {
    if (jaImprimiu) return;
    jaImprimiu = true;
    try {
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
    } catch (e) {
      toast('Erro ao abrir impressão: ' + e.message);
    }
  }
  // Espera TODAS as fotos (vêm do Google Drive) terminarem de carregar antes
  // de mandar imprimir — antes disparava num tempo fixo, e em listas grandes
  // algumas fotos ainda não tinham chegado, saindo em branco na etiqueta.
  function aguardarImagensEImprimir() {
    const imgs = Array.from(iframe.contentWindow.document.images || []);
    if (imgs.length === 0) { dispararImpressao(); return; }
    let pendentes = imgs.length;
    function marcarPronta() {
      pendentes--;
      if (pendentes <= 0) dispararImpressao();
    }
    imgs.forEach(img => {
      if (img.complete) marcarPronta();
      else {
        img.addEventListener('load', marcarPronta);
        img.addEventListener('error', marcarPronta); // não trava pra sempre se 1 foto falhar
      }
    });
    // watchdog: se alguma imagem nunca disparar load/error por bug de rede,
    // imprime assim mesmo depois de um tempo generoso, em vez de travar.
    setTimeout(dispararImpressao, 8000);
  }
  iframe.onload = aguardarImagensEImprimir;
  setTimeout(aguardarImagensEImprimir, 300);
 } catch (e) {
  toast('Erro ao montar etiquetas: ' + e.message);
 }
}

// ---------------------------------------------------------
// UTIL
// ---------------------------------------------------------
// A planilha guarda Espessura como número puro (2, 2.25, 6.3...), e o JS
// perde o zero à direita ao ler isso (2.00 vira só "2"). Essa função formata
// sempre com 2 casas e vírgula, do jeito que o pessoal do chão de fábrica
// está acostumado a ver (2,00 / 2,25 / 6,30). Se o valor já for texto (não
// numérico), mantém como está, sem tentar reformatar.
function formatarEspessura(valor) {
  if (valor === undefined || valor === null || valor === '') return '';
  const n = Number(valor);
  if (isNaN(n)) return String(valor);
  return n.toFixed(2).replace('.', ',') + 'mm';
}

// Limpa zeros à esquerda sem sentido (ex: "01", "001") assim que a pessoa
// sai do campo — por segurança, pra nunca dar ambiguidade na hora de dar
// baixa/entrada de estoque. minimoPermitido: 0 pra estoque, 1 pra quantidade.
function limparZerosQuantidade(el, minimoPermitido) {
  const min = minimoPermitido === undefined ? 1 : minimoPermitido;
  const limpo = Math.max(min, parseInt(el.value, 10) || min);
  el.value = limpo;
}

// Igual à de cima, mas deixa o campo vazio continuar vazio (usado no Estoque
// Máximo, onde "em branco" significa "sem limite" — não pode virar 0 sozinho).
function limparZerosQuantidadeOpcional(el) {
  if (el.value.trim() === '') return;
  const limpo = Math.max(0, parseInt(el.value, 10) || 0);
  el.value = limpo;
}

// Formata dimensões com separador de milhar (3000 -> 3.000). Se não for um
// número puro (ex: já vier com texto), devolve como está, sem quebrar nada.
function formatarMedida(valor) {
  if (valor === undefined || valor === null || valor === '') return '';
  const n = Number(valor);
  if (isNaN(n)) return String(valor);
  return n.toLocaleString('pt-BR');
}

function esc(str) {
  if (str === undefined || str === null) return '';
  return String(str).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

function tempoRelativo(isoStr) {
  if (!isoStr) return '';
  const diffMs = Date.now() - new Date(isoStr).getTime();
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return min + ' min atrás';
  const h = Math.floor(min / 60);
  if (h < 24) return h + 'h atrás';
  const d = Math.floor(h / 24);
  return d + 'd atrás';
}
