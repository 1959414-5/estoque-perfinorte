// ============================================================
// Programação — tela pros programadores informarem quanto conseguiram
// programar (encaixar no plano de corte) de cada pedido.
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

function esc(str) {
  if (str === undefined || str === null) return '';
  return String(str).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2600);
}

let ITEM_PROGRAMANDO_ATUAL = null;

document.addEventListener('DOMContentLoaded', function () {
  const nomeSalvo = localStorage.getItem('nomeProgramador');
  if (nomeSalvo) document.getElementById('inp-programador').value = nomeSalvo;

  document.getElementById('inp-numero-pedido').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') buscarPedido();
  });
});

function buscarPedido() {
  const programador = document.getElementById('inp-programador').value.trim();
  if (!programador) { toast('Preenche seu nome primeiro'); return; }
  localStorage.setItem('nomeProgramador', programador);

  const numero = document.getElementById('inp-numero-pedido').value.trim();
  if (!numero) { toast('Digite o número do pedido'); return; }

  const wrap = document.getElementById('prog-resultado');
  wrap.innerHTML = '<div class="empty-state">Buscando...</div>';

  apiComRetry('buscarPedidoParaProgramacao', { numeroPedido: numero })
    .then(function (itens) {
      renderResultadoBusca(itens, numero);
    })
    .catch(function (err) {
      wrap.innerHTML = '<div class="empty-state"><div class="big">Erro ao buscar</div>' + esc(err.message) + '</div>';
    });
}

function renderResultadoBusca(itens, numeroPedido) {
  const wrap = document.getElementById('prog-resultado');
  if (!itens || !itens.length) {
    wrap.innerHTML = '<div class="empty-state"><div class="big">Nada encontrado</div>Não achei itens em aberto pra esse número de pedido — confira se está certo, ou pode ser que já esteja tudo programado.</div>';
    return;
  }

  wrap.innerHTML = '<div class="section-label">Pedido ' + esc(numeroPedido) + ' — ' + itens.length + ' item' + (itens.length > 1 ? 's' : '') + ' em aberto</div>' +
    itens.map(function (item) {
      return '<div class="prog-item-card">' +
        '<div class="prog-item-id">' + esc(item.ID_Peca) + (item.Item_Perfinorte ? ' · Item ' + esc(item.Item_Perfinorte) : '') + '</div>' +
        '<div class="prog-item-nome">' + esc(item.Nome_Peca) + '</div>' +
        '<div class="prog-item-saldo">Saldo a programar: <b>' + esc(item.Quantidade) + '</b></div>' +
        '<button type="button" class="btn-primary" style="margin:0;" onclick="abrirModalProgramar(\'' + esc(item.ID_Solicitacao) + '\')">Informar quantidade programada</button>' +
        '</div>';
    }).join('');

  // guarda os itens buscados pra achar de novo na hora de abrir o modal
  window.__ITENS_BUSCADOS = itens;
}

function abrirModalProgramar(idSolicitacao) {
  const item = (window.__ITENS_BUSCADOS || []).find(i => i.ID_Solicitacao === idSolicitacao);
  if (!item) { toast('Item não encontrado — busca de novo'); return; }
  ITEM_PROGRAMANDO_ATUAL = item;

  document.getElementById('programar-peca-nome').textContent = item.Nome_Peca;
  document.getElementById('programar-peca-sub').textContent = item.ID_Peca + ' — saldo disponível: ' + item.Quantidade;
  document.getElementById('inp-qtd-programada').value = item.Quantidade;
  document.getElementById('inp-qtd-programada').max = item.Quantidade;
  document.getElementById('programar-dica').textContent =
    'Se programar menos que o saldo total, o sistema divide automaticamente em 2 vias — uma com o que você programou agora, outra com o restante pra próxima vez.';
  document.getElementById('inp-obs-programacao').value = '';
  document.getElementById('modal-programar').classList.remove('hidden');
}

function fecharModalProgramar() {
  document.getElementById('modal-programar').classList.add('hidden');
  ITEM_PROGRAMANDO_ATUAL = null;
}

function confirmarProgramacao() {
  if (!ITEM_PROGRAMANDO_ATUAL) return;
  const qtd = Number(document.getElementById('inp-qtd-programada').value);
  const saldo = Number(ITEM_PROGRAMANDO_ATUAL.Quantidade);
  if (!qtd || qtd <= 0) { toast('Quantidade inválida'); return; }
  if (qtd > saldo) { toast('Isso é mais do que o saldo disponível (' + saldo + ')'); return; }

  const programador = document.getElementById('inp-programador').value.trim();
  const observacao = document.getElementById('inp-obs-programacao').value.trim();
  const item = ITEM_PROGRAMANDO_ATUAL;

  const btn = document.getElementById('btn-confirmar-programacao');
  btn.disabled = true;
  btn.textContent = 'Registrando...';

  api('registrarProgramacao', {
    idSolicitacao: item.ID_Solicitacao,
    quantidadeProgramada: qtd,
    programador: programador,
    observacao: observacao
  })
    .then(function (resultado) {
      fecharModalProgramar();
      mostrarConfirmacaoFinal(item, qtd, saldo, resultado);
    })
    .catch(function (err) {
      toast('Erro: ' + err.message);
    })
    .finally(function () {
      btn.disabled = false;
      btn.textContent = 'Registrar';
    });
}

function mostrarConfirmacaoFinal(item, qtdProgramada, saldoAnterior, resultado) {
  const wrap = document.getElementById('prog-resultado');
  const restante = saldoAnterior - qtdProgramada;

  let html;
  if (resultado.dividido) {
    html = '<div class="prog-confirmacao dividiu">' +
      '<div class="prog-confirmacao-titulo">✅ Registrado — pedido dividido</div>' +
      '<div class="prog-confirmacao-msg">' +
      esc(item.Nome_Peca) + '<br>' +
      '<b>' + qtdProgramada + '</b> programado agora, <b>' + restante + '</b> fica pra próxima programação.<br><br>' +
      'A Bárbara já foi avisada pra imprimir as etiquetas atualizadas.' +
      '</div></div>';
  } else {
    html = '<div class="prog-confirmacao completo">' +
      '<div class="prog-confirmacao-titulo">✅ Registrado — pedido totalmente programado</div>' +
      '<div class="prog-confirmacao-msg">' + esc(item.Nome_Peca) + '<br>Todo o saldo (' + qtdProgramada + ') foi programado agora.</div></div>';
  }

  wrap.innerHTML = html;
  toast('Programação registrada!');

  // atualiza a lista removendo o item que acabou de ser processado, ou
  // busca de novo depois de um instante pra já refletir os saldos atuais
  setTimeout(function () {
    const numero = document.getElementById('inp-numero-pedido').value.trim();
    if (numero) buscarPedido();
  }, 2500);
}
