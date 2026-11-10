
let dados = [];
let semanas = [];
let semanaSelecionada = null;
let temas = [];

const cores = [
"#315f87",
"#398d9a",
"#8172aa",
"#b89b62",
"#668c70",
"#ad6f70",
"#6d78a3"
];

function escaparHtml(valor) {
  return String(valor).replace(/[&<>"']/g, caractere => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[caractere]);
}

function formatarData(valor) {
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "UTC"
  }).format(new Date(`${valor}T00:00:00.000Z`));
}

function formatarDataCurta(valor) {
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "UTC"
  }).format(new Date(`${valor}T00:00:00.000Z`));
}

function anoSemanaIso(weekStart) {
  const quinta = new Date(`${weekStart}T00:00:00.000Z`);
  quinta.setUTCDate(quinta.getUTCDate() + 3);
  return quinta.getUTCFullYear();
}

function formatarPeriodo(semana) {
  if (!semana) return "Sem dados";
  return `${formatarDataCurta(semana.week_start)} a ${formatarDataCurta(semana.week_end)}`;
}

function contar(tema) {
  return dados.filter(chamado => chamado[2] === tema).length;
}

function mostrarStatus(mensagem, tipo) {
  const status = document.getElementById("import-status");
  status.textContent = mensagem;
  status.className = `import-status is-visible is-${tipo}`;
}

async function obterJson(url, opcoes) {
  let resposta;
  try {
    resposta = await fetch(url, opcoes);
  } catch {
    throw new Error(
      "Não foi possível acessar o servidor do dashboard. Inicie o projeto com npm start na pasta bot e abra http://127.0.0.1:3000."
    );
  }

  const contentType = resposta.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new Error(
      "O painel foi aberto por um servidor estático ou pelo Live Server, que não acessa o banco SQLite. Feche esse servidor, execute npm start na pasta bot e abra http://127.0.0.1:3000."
    );
  }

  let corpo;
  try {
    corpo = await resposta.json();
  } catch {
    throw new Error("O servidor respondeu com JSON inválido. Reinicie o dashboard com npm start.");
  }

  if (!resposta.ok) throw new Error(corpo.error || `Erro na solicitação (${resposta.status}).`);
  return corpo;
}

async function carregarSemanas(semanaPreferida) {
  semanas = await obterJson("/api/weeks");
  const seletor = document.getElementById("week-filter");
  seletor.replaceChildren();

  if (!semanas.length) {
    seletor.add(new Option("Nenhuma semana disponível", ""));
    seletor.disabled = true;
    mostrarStatus("Importe um CSV com chamados e datas para começar.", "error");
    renderDashboard([]);
    return;
  }

  semanas.forEach(semana => {
    const option = new Option(
      `${anoSemanaIso(semana.week_start)}  ·  ${formatarPeriodo(semana)}  ·  ${semana.ticket_count} chamados`,
      semana.week_start
    );
    seletor.add(option);
  });
  seletor.disabled = false;

  const selecionada = semanas.find(semana => semana.week_start === semanaPreferida) || semanas[0];
  seletor.value = selecionada.week_start;
  await carregarSemana(selecionada.week_start);
}

async function carregarSemana(weekStart) {
  const semana = semanas.find(item => item.week_start === weekStart);
  if (!semana) return;

  const chamados = await obterJson(`/api/tickets?week_start=${encodeURIComponent(weekStart)}`);
  semanaSelecionada = semana;
  dados = chamados.map(chamado => [
    chamado.ticket_id,
    chamado.description,
    chamado.theme,
    chamado.journey,
    chamado.opened_at
  ]);
  temas = [...new Set(dados.map(chamado => chamado[2]))]
    .sort((a, b) => a.localeCompare(b, "pt-BR"));

  const filtro = document.getElementById("filtro");
  filtro.replaceChildren(new Option("Todos os temas", ""));
  temas.forEach(tema => filtro.add(new Option(tema, tema)));
  renderDashboard();
}

function renderDashboard() {
  const ranking = temas
    .map((tema, indice) => ({ tema, quantidade: contar(tema), indice }))
    .sort((a, b) => b.quantidade - a.quantidade || a.indice - b.indice);
  const total = dados.length;
  const maiorQuantidade = ranking[0]?.quantidade || 1;

  document.getElementById("stat-count").textContent = total;
  document.getElementById("stat-top-theme").textContent = ranking[0]?.tema || "Sem dados";
  document.getElementById("stat-top-theme-count").textContent = ranking[0]
    ? `${ranking[0].quantidade} de ${total} chamados (${(ranking[0].quantidade / total * 100).toFixed(1)}%)`
    : "Nenhum chamado nesta semana";
  document.getElementById("stat-theme-count").textContent = temas.length;
  document.getElementById("stat-week").textContent = semanaSelecionada
    ? anoSemanaIso(semanaSelecionada.week_start)
    : "—";
  document.getElementById("stat-week-range").textContent = formatarPeriodo(semanaSelecionada);
  document.getElementById("print-week-heading").textContent = semanaSelecionada
    ? `${anoSemanaIso(semanaSelecionada.week_start)} · ${formatarPeriodo(semanaSelecionada)}`
    : "Sem semana selecionada";

  document.getElementById("bars").innerHTML = ranking.map(({ tema, quantidade }, indice) => `
    <div class="bar">
      <div class="bar-title">
        <strong><span class="bar-rank">${indice + 1}</span>${escaparHtml(tema)}</strong>
        <span>${quantidade} chamados (${(quantidade / total * 100).toFixed(1)}%)</span>
      </div>
      <div class="track">
        <div class="fill" style="width:${quantidade / maiorQuantidade * 100}%;background:${cores[indice % cores.length]}"></div>
      </div>
    </div>
  `).join("") || '<p class="empty-state">Nenhum dado para esta semana.</p>';

  document.getElementById("legend").innerHTML = ranking.map(({ tema, quantidade }, indice) => `
    <div class="legend-item">
      <span class="dot" style="background:${cores[indice % cores.length]}"></span>
      <span>${escaparHtml(tema)}: <strong>${quantidade}</strong> (${(quantidade / total * 100).toFixed(1)}%)</span>
    </div>
  `).join("") || '<p class="empty-state">Nenhum tema cadastrado.</p>';

  document.querySelector(".insights").innerHTML = ranking.slice(0, 3).map(({ tema, quantidade }, indice) => `
    <div class="card insight">
      <strong>${indice === 0 ? "Maior tema da semana" : `Tema ${indice + 1} da semana`}</strong>
      <p><b>${escaparHtml(tema)}</b> aparece em ${quantidade} de ${total} chamados (${(quantidade / total * 100).toFixed(1)}%).</p>
    </div>
  `).join("") || '<div class="card insight"><p>Não há temas para exibir nesta semana.</p></div>';

  render();
}

function render() {
  const busca = document.getElementById("busca").value.trim().toLocaleLowerCase("pt-BR");
  const filtro = document.getElementById("filtro").value;
  const filtrados = dados.filter(chamado =>
    (!filtro || chamado[2] === filtro) &&
    chamado.join(" ").toLocaleLowerCase("pt-BR").includes(busca)
  );

  document.getElementById("tabela").innerHTML = filtrados.map(chamado => `
    <tr>
      <td><a href="https://atendimento-paytrack.zendesk.com/agent/tickets/${encodeURIComponent(chamado[0])}" target="_blank" rel="noopener noreferrer">${escaparHtml(chamado[0])}</a></td>
      <td>${escaparHtml(chamado[1])}</td>
      <td><span class="tag">${escaparHtml(chamado[2])}</span></td>
      <td><span class="tag journey">${escaparHtml(chamado[3])}</span></td>
      <td>${formatarData(chamado[4])}</td>
    </tr>
  `).join("") || '<tr><td class="empty-state" colspan="5">Nenhum chamado encontrado para esta busca.</td></tr>';

  document.getElementById("resultado-count").textContent =
    `${filtrados.length} ${filtrados.length === 1 ? "chamado" : "chamados"}`;
}

function escaparXml(valor) {
  return String(valor)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function criarCelula(valor, estilo, tipo) {
  const referencia = tipo.referencia;
  const conteudo = tipo.numerico
    ? `<v>${valor}</v>`
    : `<is><t xml:space="preserve">${escaparXml(valor)}</t></is>`;
  const tipoCelula = tipo.numerico ? "" : ' t="inlineStr"';

  return `<c r="${referencia}" s="${estilo}"${tipoCelula}>${conteudo}</c>`;
}

function criarLinha(numero, celulas, altura) {
  return `<row r="${numero}"${altura ? ` ht="${altura}" customHeight="1"` : ""}>${celulas.join("")}</row>`;
}

function celulasMescladas(inicio, fim, numero, valor, estilo) {
  return Array.from({ length: fim - inicio + 1 }, (_, indice) => {
    const coluna = String.fromCharCode(65 + inicio + indice);
    const referencia = `${coluna}${numero}`;

    return criarCelula(indice === 0 ? valor : "", estilo, { referencia });
  });
}

function contarTemasOrdenados() {
  return temas
    .map((tema, indice) => ({ tema, quantidade: contar(tema), indice }))
    .sort((a, b) => b.quantidade - a.quantidade || a.indice - b.indice);
}

function criarPlanilhaResumoXml() {
  const ranking = contarTemasOrdenados();
  const maiorQuantidade = ranking[0]?.quantidade || 1;
  const periodo = formatarPeriodo(semanaSelecionada);
  const linhas = [
    criarLinha(1, celulasMescladas(0, 3, 1, "PAYTRACK  |  RELATÓRIO DE CHAMADOS", 1), 40),
    criarLinha(2, celulasMescladas(0, 3, 2, `Resumo executivo  ·  ${anoSemanaIso(semanaSelecionada.week_start)}  ·  ${periodo}`, 2), 25),
    criarLinha(3, []),
    criarLinha(4, celulasMescladas(0, 3, 4, "INDICADORES DA AMOSTRA", 3), 26),
    criarLinha(5, [
      ...celulasMescladas(0, 1, 5, "CHAMADOS ANALISADOS", 4),
      ...celulasMescladas(2, 3, 5, "TEMAS MAPEADOS", 6)
    ], 25),
    criarLinha(6, [
      ...celulasMescladas(0, 1, 6, dados.length, 5),
      ...celulasMescladas(2, 3, 6, temas.length, 7)
    ], 44),
    criarLinha(7, []),
    criarLinha(8, celulasMescladas(0, 3, 8, "DISTRIBUIÇÃO DOS PRINCIPAIS OFENSORES", 3), 26),
    criarLinha(9, [
      ["Tema", "A9"],
      ["Chamados", "B9"],
      ["Participação", "C9"],
      ["Comparativo", "D9"]
    ].map(([valor, referencia]) => criarCelula(valor, 8, { referencia })), 28),
    ...ranking.map(({ tema, quantidade }, indice) => {
      const numero = indice + 10;
      const estilo = indice % 2 === 0 ? 9 : 10;
      const participacao = quantidade / dados.length;
      const barra = "■".repeat(Math.max(1, Math.round(quantidade / maiorQuantidade * 16)));

      return criarLinha(numero, [
        criarCelula(tema, estilo, { referencia: `A${numero}` }),
        criarCelula(quantidade, 11, { referencia: `B${numero}`, numerico: true }),
        criarCelula(participacao, 12, { referencia: `C${numero}`, numerico: true }),
        criarCelula(barra, 13, { referencia: `D${numero}` })
      ], 27);
    }),
    criarLinha(14, []),
    criarLinha(15, celulasMescladas(0, 3, 15, "DESTAQUE DA ANÁLISE", 3), 26),
    criarLinha(16, celulasMescladas(
      0,
      3,
      16,
      `${ranking[0].tema} concentra ${ranking[0].quantidade} de ${dados.length} chamados (${(ranking[0].quantidade / dados.length * 100).toFixed(1).replace(".", ",")}% da amostra).`,
      14
    ), 38)
  ];

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetPr><tabColor rgb="FFC6A86A"/></sheetPr>
  <dimension ref="A1:D16"/>
  <sheetViews><sheetView workbookViewId="0" showGridLines="0"><selection activeCell="A1" sqref="A1"/></sheetView></sheetViews>
  <sheetFormatPr defaultRowHeight="22"/>
  <cols>
    <col min="1" max="1" width="38" customWidth="1"/>
    <col min="2" max="2" width="16" customWidth="1"/>
    <col min="3" max="3" width="20" customWidth="1"/>
    <col min="4" max="4" width="29" customWidth="1"/>
  </cols>
  <sheetData>${linhas.join("")}</sheetData>
  <mergeCells count="10">
    <mergeCell ref="A1:D1"/><mergeCell ref="A2:D2"/><mergeCell ref="A4:D4"/>
    <mergeCell ref="A5:B5"/><mergeCell ref="C5:D5"/>
    <mergeCell ref="A6:B6"/><mergeCell ref="C6:D6"/>
    <mergeCell ref="A8:D8"/><mergeCell ref="A15:D15"/><mergeCell ref="A16:D16"/>
  </mergeCells>
</worksheet>`;
}

function criarPlanilhaChamadosXml() {
  const ultimaLinha = dados.length + 4;
  const linhas = [
    criarLinha(1, celulasMescladas(0, 4, 1, "BASE DE CHAMADOS  |  PAYTRACK", 1), 40),
    criarLinha(2, celulasMescladas(0, 4, 2, `${dados.length} registros  ·  ${formatarPeriodo(semanaSelecionada)}  ·  Dados da semana selecionada`, 2), 25),
    criarLinha(3, []),
    criarLinha(4, [
      ["Chamado", "A4"],
      ["Descrição", "B4"],
      ["Tema", "C4"],
      ["Jornada", "D4"],
      ["Data", "E4"]
    ].map(([valor, referencia]) => criarCelula(valor, 8, { referencia })), 28),
    ...dados.map((registro, indice) => {
      const numero = indice + 5;
      const estilo = indice % 2 === 0 ? 9 : 10;

      return criarLinha(numero, registro.map((valor, coluna) =>
        criarCelula(
          valor,
          coluna === 0 ? 11 : estilo,
          { referencia: `${"ABCDE"[coluna]}${numero}`, numerico: coluna === 0 }
        )
      ), 27);
    })
  ];

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetPr><tabColor rgb="FF315F87"/></sheetPr>
  <dimension ref="A1:E${ultimaLinha}"/>
  <sheetViews><sheetView workbookViewId="0" showGridLines="0"><pane ySplit="4" topLeftCell="A5" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A5" sqref="A5"/></sheetView></sheetViews>
  <sheetFormatPr defaultRowHeight="21"/>
  <cols>
    <col min="1" max="1" width="16" customWidth="1"/>
    <col min="2" max="2" width="43" customWidth="1"/>
    <col min="3" max="3" width="36" customWidth="1"/>
    <col min="4" max="4" width="28" customWidth="1"/>
    <col min="5" max="5" width="16" customWidth="1"/>
  </cols>
  <sheetData>${linhas.join("")}</sheetData>
  <autoFilter ref="A4:E${ultimaLinha}"/>
  <mergeCells count="2"><mergeCell ref="A1:E1"/><mergeCell ref="A2:E2"/></mergeCells>
</worksheet>`;
}

function criarEstilosXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="1"><numFmt numFmtId="164" formatCode="0.0%"/></numFmts>
  <fonts count="10">
    <font><sz val="11"/><name val="Aptos"/></font>
    <font><b/><sz val="21"/><color rgb="FFFFFFFF"/><name val="Aptos Display"/></font>
    <font><sz val="10"/><color rgb="FFE3EAF1"/><name val="Aptos"/></font>
    <font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Aptos"/></font>
    <font><b/><sz val="9"/><color rgb="FF61748A"/><name val="Aptos"/></font>
    <font><b/><sz val="25"/><color rgb="FF1D3854"/><name val="Aptos Display"/></font>
    <font><b/><sz val="25"/><color rgb="FF287C79"/><name val="Aptos Display"/></font>
    <font><b/><sz val="11"/><color rgb="FF34495E"/><name val="Aptos"/></font>
    <font><b/><sz val="13"/><color rgb="FF315F87"/><name val="Aptos"/></font>
    <font><i/><sz val="10"/><color rgb="FF5A6D82"/><name val="Aptos"/></font>
  </fonts>
  <fills count="7">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF14283F"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF315F87"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFF0F4F7"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFEAF1F6"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFEAF5F2"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border><left/><right/><top/><bottom style="thin"><color rgb="FFE4EAF0"/></bottom><diagonal/></border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="15">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center"/></xf>
    <xf numFmtId="0" fontId="2" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center"/></xf>
    <xf numFmtId="0" fontId="3" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center"/></xf>
    <xf numFmtId="0" fontId="4" fillId="4" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center"/></xf>
    <xf numFmtId="0" fontId="5" fillId="5" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="4" fillId="6" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="6" fillId="6" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="3" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="4" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
    <xf numFmtId="0" fontId="7" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="164" fontId="7" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="8" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
    <xf numFmtId="0" fontId="9" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
}

function crc32(bytes) {
  let crc = 0xFFFFFFFF;

  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }

  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function criarArquivoZip(arquivos) {
  const codificador = new TextEncoder();
  const arquivosLocais = [];
  const diretorioCentral = [];
  let deslocamento = 0;

  arquivos.forEach(([nome, conteudo]) => {
    const nomeBytes = codificador.encode(nome);
    const dadosBytes = codificador.encode(conteudo);
    const crc = crc32(dadosBytes);
    const local = new DataView(new ArrayBuffer(30 + nomeBytes.length));

    local.setUint32(0, 0x04034B50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true);
    local.setUint16(8, 0, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, dadosBytes.length, true);
    local.setUint32(22, dadosBytes.length, true);
    local.setUint16(26, nomeBytes.length, true);
    new Uint8Array(local.buffer, 30).set(nomeBytes);
    arquivosLocais.push(local.buffer, dadosBytes);

    const central = new DataView(new ArrayBuffer(46 + nomeBytes.length));
    central.setUint32(0, 0x02014B50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(8, 0x0800, true);
    central.setUint16(10, 0, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, dadosBytes.length, true);
    central.setUint32(24, dadosBytes.length, true);
    central.setUint16(28, nomeBytes.length, true);
    central.setUint32(42, deslocamento, true);
    new Uint8Array(central.buffer, 46).set(nomeBytes);
    diretorioCentral.push(central.buffer);

    deslocamento += local.byteLength + dadosBytes.length;
  });

  const tamanhoCentral = diretorioCentral.reduce((total, parte) => total + parte.byteLength, 0);
  const fim = new DataView(new ArrayBuffer(22));
  fim.setUint32(0, 0x06054B50, true);
  fim.setUint16(8, arquivos.length, true);
  fim.setUint16(10, arquivos.length, true);
  fim.setUint32(12, tamanhoCentral, true);
  fim.setUint32(16, deslocamento, true);

  return new Blob([...arquivosLocais, ...diretorioCentral, fim.buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  });
}

function baixarArquivo(arquivo, nome) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(arquivo);
  link.download = nome;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function exportarExcel() {
  if (!dados.length || !semanaSelecionada) {
    mostrarStatus("Não há chamados para exportar nesta semana.", "error");
    return;
  }

  const arquivos = [
    ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`],
    ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`],
    ["xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <bookViews><workbookView activeTab="0"/></bookViews>
  <sheets>
    <sheet name="Resumo executivo" sheetId="1" r:id="rId1"/>
    <sheet name="Base de chamados" sheetId="2" r:id="rId2"/>
  </sheets>
</workbook>`],
    ["xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`],
    ["xl/styles.xml", criarEstilosXml()],
    ["xl/worksheets/sheet1.xml", criarPlanilhaResumoXml()],
    ["xl/worksheets/sheet2.xml", criarPlanilhaChamadosXml()]
  ];

  baixarArquivo(
    criarArquivoZip(arquivos),
    `chamados_paytrack_${semanaSelecionada.week_start}.xlsx`
  );
}

function exportarPdf() {
  if (!dados.length || !semanaSelecionada) {
    mostrarStatus("Não há chamados para exportar nesta semana.", "error");
    return;
  }

  window.print();
}
document.getElementById("busca").addEventListener("input", render);
document.getElementById("filtro").addEventListener("change", render);
document.getElementById("week-filter").addEventListener("change", event => {
  carregarSemana(event.target.value).catch(error => mostrarStatus(error.message, "error"));
});
document.getElementById("btn-exportar-excel").addEventListener("click", exportarExcel);
document.getElementById("btn-exportar-pdf").addEventListener("click", exportarPdf);

carregarSemanas().catch(error => {
  mostrarStatus(error.message, "error");
  renderDashboard([]);
});
