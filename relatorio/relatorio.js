// ============================================================
// Relatório de Estoque — dashboard de Entradas/Saídas com gráficos
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
  setTimeout(() => t.classList.remove('show'), 2400);
}

let MOVIMENTOS = [];
let CHART_LINHA = null;
let CHART_TOP = null;

document.addEventListener('DOMContentLoaded', function () {
  // Mesma trava de PIN do app principal — se já tiver desbloqueado lá nesse
  // navegador, já entra direto aqui também (é o mesmo localStorage/origem).
  if (localStorage.getItem('modoAdmin') === 'true') {
    desbloquearRelatorio();
  }

  document.getElementById('inp-pin').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') verificarPinRelatorio();
  });

  document.querySelectorAll('#periodo-chips .filter-chip').forEach(chip => {
    chip.addEventListener('click', () => selecionarPeriodo(chip.dataset.periodo, chip));
  });
});

function verificarPinRelatorio() {
  const pin = document.getElementById('inp-pin').value;
  if (!pin) return;
  toast('Verificando...');
  apiComRetry('verificarPin', { pin: pin })
    .then(function (ok) {
      if (ok) {
        localStorage.setItem('modoAdmin', 'true');
        desbloquearRelatorio();
      } else {
        document.getElementById('pin-erro').classList.remove('hidden');
      }
    })
    .catch(function (err) { toast('Não consegui verificar o PIN (tentei 3x): ' + err.message); });
}

function desbloquearRelatorio() {
  document.getElementById('tela-pin').classList.add('hidden');
  document.getElementById('conteudo-relatorio').classList.remove('hidden');
  selecionarPeriodo('mes-atual', document.querySelector('[data-periodo="mes-atual"]'));
}

// ---- período ----
function fmtLocal(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dia = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + dia;
}

function nomeMes(d) {
  const s = d.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatarDataBR(iso) {
  const [y, m, d] = iso.split('-');
  return d + '/' + m + '/' + y;
}

function calcularIntervalo(periodo) {
  const hoje = new Date();
  const y = hoje.getFullYear(), m = hoje.getMonth();

  if (periodo === 'hoje') {
    return { inicio: fmtLocal(hoje), fim: fmtLocal(hoje), label: 'Hoje' };
  }
  if (periodo === '30dias') {
    const ini = new Date(hoje.getTime() - 29 * 24 * 60 * 60 * 1000);
    return { inicio: fmtLocal(ini), fim: fmtLocal(hoje), label: 'Últimos 30 dias' };
  }
  if (periodo === 'mes-passado') {
    const ini = new Date(y, m - 1, 1);
    const fimMes = new Date(y, m, 0);
    return { inicio: fmtLocal(ini), fim: fmtLocal(fimMes), label: nomeMes(ini) };
  }
  const ini = new Date(y, m, 1);
  return { inicio: fmtLocal(ini), fim: fmtLocal(hoje), label: nomeMes(ini) };
}

function selecionarPeriodo(periodo, el) {
  document.querySelectorAll('#periodo-chips .filter-chip').forEach(c => c.classList.remove('selected'));
  if (el) el.classList.add('selected');
  document.getElementById('periodo-custom').classList.toggle('hidden', periodo !== 'personalizado');
  if (periodo === 'personalizado') return; // espera a pessoa preencher e clicar Aplicar
  const { inicio, fim, label } = calcularIntervalo(periodo);
  carregarRelatorio(inicio, fim, label);
}

function aplicarPeriodoCustom() {
  const inicio = document.getElementById('data-inicio').value;
  const fim = document.getElementById('data-fim').value;
  if (!inicio || !fim) { toast('Preencha as duas datas'); return; }
  if (inicio > fim) { toast('A data inicial não pode ser depois da final'); return; }
  carregarRelatorio(inicio, fim, formatarDataBR(inicio) + ' até ' + formatarDataBR(fim));
}

// ---- carregamento e render ----
function carregarRelatorio(inicio, fim, label) {
  document.getElementById('rel-periodo-label').textContent = label;
  document.getElementById('tabela-movimentos-body').innerHTML = '<tr><td colspan="7">Carregando...</td></tr>';

  apiComRetry('getMovimentosEstoque', { dataInicio: inicio, dataFim: fim })
    .then(function (lista) {
      MOVIMENTOS = lista || [];
      renderKPIs();
      renderGraficoLinha(inicio, fim);
      renderGraficoTopPecas();
      renderTabela();
    })
    .catch(function (err) { toast('Erro ao carregar: ' + err.message); });
}

function renderKPIs() {
  let totalEntrada = 0, totalSaida = 0;
  MOVIMENTOS.forEach(m => {
    const qtd = Number(m.Quantidade) || 0;
    if (m.Tipo === 'Entrada') totalEntrada += qtd; else totalSaida += qtd;
  });
  document.getElementById('kpi-entradas').textContent = totalEntrada;
  document.getElementById('kpi-saidas').textContent = totalSaida;
  const saldo = totalEntrada - totalSaida;
  document.getElementById('kpi-saldo').textContent = (saldo > 0 ? '+' : '') + saldo;
  document.getElementById('kpi-total-mov').textContent = MOVIMENTOS.length;
}

function renderGraficoLinha(inicio, fim) {
  const dias = [];
  const d0 = new Date(inicio + 'T00:00:00');
  const d1 = new Date(fim + 'T00:00:00');
  for (let d = new Date(d0); d <= d1; d.setDate(d.getDate() + 1)) {
    dias.push(fmtLocal(d));
  }

  const entradasPorDia = {}, saidasPorDia = {};
  dias.forEach(d => { entradasPorDia[d] = 0; saidasPorDia[d] = 0; });
  MOVIMENTOS.forEach(m => {
    const diaKey = fmtLocal(new Date(m.Data_Hora));
    if (entradasPorDia[diaKey] === undefined) return;
    const qtd = Number(m.Quantidade) || 0;
    if (m.Tipo === 'Entrada') entradasPorDia[diaKey] += qtd; else saidasPorDia[diaKey] += qtd;
  });

  const labels = dias.map(d => d.slice(8, 10) + '/' + d.slice(5, 7));
  const dadosEntrada = dias.map(d => entradasPorDia[d]);
  const dadosSaida = dias.map(d => saidasPorDia[d]);

  if (CHART_LINHA) CHART_LINHA.destroy();
  CHART_LINHA = new Chart(document.getElementById('chart-linha'), {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [
        { label: 'Entradas', data: dadosEntrada, backgroundColor: '#15803D', borderRadius: 3 },
        { label: 'Saídas', data: dadosSaida, backgroundColor: '#DC2626', borderRadius: 3 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
      plugins: { legend: { position: 'bottom' } },
    },
  });
}

function renderGraficoTopPecas() {
  const porPeca = {};
  MOVIMENTOS.forEach(m => {
    const nome = m.Nome_Peca || m.ID_Peca || '—';
    const qtd = Number(m.Quantidade) || 0;
    porPeca[nome] = (porPeca[nome] || 0) + qtd;
  });
  const ordenado = Object.entries(porPeca).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const labels = ordenado.map(x => x[0].length > 30 ? x[0].slice(0, 30) + '…' : x[0]);
  const dados = ordenado.map(x => x[1]);

  if (CHART_TOP) CHART_TOP.destroy();
  CHART_TOP = new Chart(document.getElementById('chart-top-pecas'), {
    type: 'bar',
    data: { labels: labels, datasets: [{ label: 'Quantidade movimentada', data: dados, backgroundColor: '#C77D00', borderRadius: 3 }] },
    options: {
      indexAxis: 'y',
      responsive: true, maintainAspectRatio: false,
      scales: { x: { beginAtZero: true, ticks: { precision: 0 } } },
      plugins: { legend: { display: false } },
    },
  });
}

function renderTabela() {
  const tbody = document.getElementById('tabela-movimentos-body');
  const vazio = document.getElementById('tabela-mov-vazia');
  const tabela = document.getElementById('tabela-movimentos');
  const ordenados = MOVIMENTOS.slice().sort((a, b) => new Date(b.Data_Hora) - new Date(a.Data_Hora));

  if (!ordenados.length) {
    tabela.classList.add('hidden');
    vazio.classList.remove('hidden');
    return;
  }
  tabela.classList.remove('hidden');
  vazio.classList.add('hidden');

  tbody.innerHTML = ordenados.map(m => {
    const data = new Date(m.Data_Hora);
    const dataFmt = data.toLocaleDateString('pt-BR') + ' ' + data.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const tipoClasse = m.Tipo === 'Entrada' ? 'tag-entrada' : 'tag-saida';
    return '<tr>' +
      '<td>' + dataFmt + '</td>' +
      '<td>' + esc(m.Nome_Peca || m.ID_Peca) + '</td>' +
      '<td class="' + tipoClasse + '">' + esc(m.Tipo) + '</td>' +
      '<td>' + esc(m.Quantidade) + '</td>' +
      '<td>' + esc(m.Estoque_Antes) + ' → ' + esc(m.Estoque_Depois) + '</td>' +
      '<td>' + esc(m.Usuario) + '</td>' +
      '<td>' + esc(m.Observacao || '—') + '</td>' +
      '</tr>';
  }).join('');
}
