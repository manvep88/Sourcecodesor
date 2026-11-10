// ==UserScript==
// @name         SORITICKET - Captura de tickets Soriana (solo consulta)
// @namespace    https://www.soriana.com/
// @version      1.3.9
// @description  Consulta tickets en la vista previa, guarda productos y totales y exporta un archivo JSON. No emite facturas.
// @author       OpenAI
// @match        https://www.soriana.com/facturacion*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const VERSION = '1.3.9';
  const STORAGE_META = 'soriticket.capture.meta.v1';
  const STORAGE_CHUNK = 'soriticket.capture.records.v1:';
  const CHUNK_SIZE = 25;
  const TICKET_LENGTH = 20;
  const POLL_MS = 300;
  const PREVIEW_TIMEOUT_MS = 45000;
  const FORM_TIMEOUT_MS = 90000;

  const STATUS = Object.freeze({
    pending: 'Pendiente',
    capturing: 'Consultando',
    captured: 'Capturado',
    captured_incomplete: 'Capturado con datos incompletos',
    duplicate: 'Duplicado en archivo',
    invalid_format: 'Formato inválido',
    already_invoiced: 'Ya facturado en Soriana',
    not_found: 'Ticket sin información',
    service_unavailable: 'Servicio no disponible',
    error: 'Error de consulta'
  });

  const DEPARTMENTS = [
    { id: 'frutas-verduras', name: 'Frutas y verduras', words: ['fruta','verdura','manzana','platano','banana','naranja','limon','aguacate','jitomate','tomate','cebolla','papa','zanahoria','lechuga','pepino','cilantro','chile serrano','brocoli','calabaza','uva','fresa','melon','sandia','papaya','mango','pera','piña','pina','apio','espinaca'] },
    { id: 'carnes-pescados', name: 'Carnes y pescados', words: ['res','bistec','molida','pollo','pechuga','pierna','muslo','pescado','atun fresco','camaron','cerdo','costilla','arrachera','carne','filete','chuleta'] },
    { id: 'carnes-frias', name: 'Carnes frías y embutidos', words: ['jamon','salchicha','tocino','mortadela','peperoni','chorizo','longaniza','pavo rebanado','salami'] },
    { id: 'lacteos', name: 'Lácteos y refrigerados', words: ['leche','queso','yogur','yoghurt','crema','mantequilla','margarina','flan','crema acida','requeson','media crema'] },
    { id: 'panaderia', name: 'Panadería y tortillería', words: ['pan','bolillo','tortilla','telera','pastel','dona','donut','galleta pan','pastelillo','birote','baguette'] },
    { id: 'abarrotes', name: 'Abarrotes', words: ['arroz','frijol','azucar','sal','aceite','harina','pasta','sopa','atun lata','sardina','mayonesa','catsup','pure de tomate','cereal','avena','cafe','te ','chocolate polvo','consome','caldo','chile seco','especias','vinagre','aderezo','mermelada','miel','lenteja','garbanzo','galleta','enlatado','conserva'] },
    { id: 'bebidas', name: 'Bebidas', words: ['agua','refresco','jugo','néctar','nectar','bebida','suero','energetica','isotonica','cafe listo','te helado','mineral'] },
    { id: 'botanas-dulces', name: 'Botanas y dulces', words: ['papas fritas','botana','fritura','cacahuate','nuez','semilla','palomitas','chicle','caramelo','chocolate','dulce','gomita','mazapan','barra'] },
    { id: 'congelados', name: 'Congelados', words: ['congelado','helado','nieve','pizza congelada','vegetales congelados','verdura congelada','nugget','croqueta'] },
    { id: 'limpieza-hogar', name: 'Limpieza del hogar', words: ['detergente','suavizante','cloro','limpiador','desinfectante','lavatrastes','jabon ropa','multiusos','escoba','trapeador','bolsa basura','aromatizante','esponja','fibra','servilleta','toalla cocina','papel aluminio','film'] },
    { id: 'higiene-personal', name: 'Higiene personal', words: ['shampoo','acondicionador','jabon corporal','jabon tocador','pasta dental','cepillo dental','desodorante','rastrillo','afeitar','papel higienico','toalla sanitaria','algodon','hisopo','enjuague bucal','protector diario'] },
    { id: 'belleza', name: 'Belleza y cosméticos', words: ['maquillaje','labial','rimel','mascara pestañas','delineador','base maquillaje','polvo compacto','rubor','esmalte','acetona','perfume','locion','crema facial','tinte cabello'] },
    { id: 'bebes', name: 'Bebés', words: ['formula infantil','leche maternizada','papilla','alimento bebe','toallitas humedas','pañal','pañales','panal','panales','pañal bebe','panal bebe','biberon'] },
    { id: 'mascotas', name: 'Mascotas', words: ['croquetas','alimento perro','alimento gato','arena gato','mascota','sobre perro','sobre gato'] },
    { id: 'farmacia', name: 'Farmacia y cuidado', words: ['curita','venda','termometro','analgesico','vitamina','suplemento','antiseptico','alcohol gel','cubrebocas','medicamento'] },
    { id: 'hogar-cocina', name: 'Hogar y cocina', words: ['vaso','plato','cubierto','sarten','olla','recipiente','contenedor','foco','pila','bateria','utensilio','taza','termo','mantel','organizador'] },
    { id: 'electronica', name: 'Electrónica y accesorios', words: ['cable usb','audifono','cargador','bocina','memoria usb','electronico','adaptador','control remoto'] },
    { id: 'ropa', name: 'Ropa y textiles', words: ['playera','camiseta','calcetin','ropa','toalla baño','sabana','cobija','almohada'] }
  ];

  const normalize = value => String(value ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();

  function classifyDepartment(description, code = '') {
    const text = ` ${normalize(description)} ${normalize(code)} `;
    for (const department of DEPARTMENTS) {
      if (department.words.some(word => {
        const term = normalize(word);
        return text.includes(` ${term} `) || (term.length > 3 && text.includes(term));
      })) return department.id;
    }
    return 'otros';
  }

  function isVisible(element) {
    if (!element || !element.isConnected || element.hidden) return false;
    const style = window.getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' &&
      !element.classList.contains('d-none') &&
      (element.getClientRects().length > 0 || element.classList.contains('show'));
  }

  const $page = selector => document.querySelector(selector);
  const sleep = ms => new Promise(resolve => window.setTimeout(resolve, ms));
  const nowIso = () => new Date().toISOString();

  let state = null;
  const localStore = (() => { try { return window.localStorage; } catch (_) { return null; } })();
  const sessionStore = (() => { try { return window.sessionStorage; } catch (_) { return null; } })();
  let stateStorage = localStore || sessionStore;
  let loopActive = false;
  let pauseRequested = false;

  function chunkKey(index) { return `${STORAGE_CHUNK}${index}`; }

  function clearStorage(storage) {
    if (!storage) return;
    try {
      storage.removeItem(STORAGE_META);
      for (let i = storage.length - 1; i >= 0; i -= 1) {
        const key = storage.key(i);
        if (key && key.startsWith(STORAGE_CHUNK)) storage.removeItem(key);
      }
    } catch (_) { /* almacenamiento no disponible */ }
  }

  function readStored(storage) {
    const rawMeta = storage.getItem(STORAGE_META);
    if (!rawMeta) return null;
    const meta = JSON.parse(rawMeta);
    if (meta?.schemaVersion !== 1 || !Number.isInteger(meta.recordChunkCount)) return null;
    const records = [];
    for (let i = 0; i < meta.recordChunkCount; i += 1) {
      const rawChunk = storage.getItem(chunkKey(i));
      if (!rawChunk) throw new Error(`Falta el bloque de datos ${i + 1} de ${meta.recordChunkCount}.`);
      const chunk = JSON.parse(rawChunk);
      if (!Array.isArray(chunk)) throw new Error(`El bloque ${i + 1} no tiene un formato válido.`);
      records.push(...chunk);
    }
    if (records.length !== Number(meta.recordCount)) throw new Error('El conteo de tickets no coincide con los bloques guardados.');
    delete meta.recordChunkCount;
    delete meta.recordCount;
    return { ...meta, records };
  }

  function loadState() {
    for (const storage of [localStore, sessionStore].filter(Boolean)) {
      try {
        const loaded = readStored(storage);
        if (loaded) { stateStorage = storage; return loaded; }
      } catch (error) {
        console.error('[SORITICKET] No se pudo leer el archivo local:', error);
      }
    }
    return null;
  }

  function metadataForStorage() {
    const meta = { ...state };
    delete meta.records;
    meta.schemaVersion = 1;
    meta.recordCount = state.records.length;
    meta.recordChunkCount = Math.ceil(state.records.length / CHUNK_SIZE);
    return meta;
  }

  function persistTo(storage, changedIndex = null, forceAll = false) {
    const count = Math.ceil(state.records.length / CHUNK_SIZE);
    const indexes = forceAll || changedIndex === null
      ? Array.from({ length: count }, (_, i) => i)
      : [Math.floor(changedIndex / CHUNK_SIZE)];
    for (const index of indexes) {
      const start = index * CHUNK_SIZE;
      storage.setItem(chunkKey(index), JSON.stringify(state.records.slice(start, start + CHUNK_SIZE)));
    }
    storage.setItem(STORAGE_META, JSON.stringify(metadataForStorage()));
  }

  function saveState(changedIndex = null, forceAll = false) {
    if (!state) return false;
    state.updatedAt = nowIso();
    if (!stateStorage) {
      setStatus('El navegador bloqueó localStorage y sessionStorage. Los datos siguen en memoria; exporta el JSON antes de cerrar o recargar la página.');
      return true;
    }
    try {
      persistTo(stateStorage, changedIndex, forceAll);
      return true;
    } catch (primaryError) {
      if (sessionStore && stateStorage !== sessionStore) {
        try {
          clearStorage(sessionStore);
          persistTo(sessionStore, null, true);
          clearStorage(localStore);
          stateStorage = sessionStore;
          setStatus('El almacenamiento permanente alcanzó su límite. Los datos se conservan en esta sesión; exporta el JSON para respaldarlos.');
          return true;
        } catch (sessionError) {
          console.error('[SORITICKET] Falló el respaldo de sesión:', sessionError);
        }
      }
      console.error('[SORITICKET] No se pudo guardar el lote:', primaryError);
      setStatus('ERROR DE ALMACENAMIENTO: proceso detenido para evitar pérdida de tickets. Exporta o libera espacio antes de continuar.');
      return false;
    }
  }

  function parseDelimited(text, delimiter) {
    const rows = [];
    let row = [], field = '', quoted = false;
    for (let i = 0; i < text.length; i += 1) {
      const char = text[i];
      if (quoted) {
        if (char === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
        else if (char === '"') quoted = false;
        else field += char;
      } else if (char === '"' && field.length === 0) quoted = true;
      else if (char === delimiter) { row.push(field); field = ''; }
      else if (char === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
      else field += char;
    }
    row.push(field.replace(/\r$/, ''));
    if (row.length > 1 || row[0] !== '' || !rows.length) rows.push(row);
    return rows;
  }

  function chooseDelimiter(text) {
    const line = String(text).replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] || '';
    let best = ',', bestCount = -1;
    for (const delimiter of [',', ';', '\t']) {
      let quoted = false, count = 0;
      for (let i = 0; i < line.length; i += 1) {
        if (line[i] === '"') {
          if (quoted && line[i + 1] === '"') i += 1;
          else quoted = !quoted;
        } else if (line[i] === delimiter && !quoted) count += 1;
      }
      if (count > bestCount) { best = delimiter; bestCount = count; }
    }
    return best;
  }

  function extractTicketCodes(value) {
    const codes = [];
    const regex = /(?:^|[^0-9])([0-9]{20})(?![0-9])/g;
    let match;
    while ((match = regex.exec(String(value ?? ''))) !== null) codes.push(match[1]);
    return codes;
  }

  function importCsv(text, fileName, branchDefault, purchaseDateDefault) {
    const clean = String(text || '').replace(/^\uFEFF/, '');
    const rows = parseDelimited(clean, chooseDelimiter(clean));
    const records = [], firstSeen = new Map();
    for (let rowIndex = 8; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex];
      const startCol = rowIndex === 8 ? 1 : 0;
      for (let col = startCol; col < row.length; col += 1) {
        for (const ticket of extractTicketCodes(row[col])) {
          const record = {
            id: `${ticket}-${records.length + 1}`,
            ticketNumber: ticket,
            series: '',
            branch: String(branchDefault || '').trim(),
            branchSource: branchDefault ? 'batch_default' : 'missing',
            purchaseDate: String(purchaseDateDefault || '').trim(),
            purchaseDateSource: purchaseDateDefault ? 'batch_default' : 'missing',
            purchaseTime: '',
            status: 'pending',
            detail: 'Código de ticket de 20 dígitos detectado desde B9.',
            sourceRow: rowIndex + 1,
            capturedAt: '',
            currency: 'MXN',
            items: [],
            totals: {},
            warnings: []
          };
          if (firstSeen.has(ticket)) {
            record.status = 'duplicate';
            record.detail = `Código duplicado; primera aparición en la fila ${firstSeen.get(ticket)}.`;
          } else firstSeen.set(ticket, rowIndex + 1);
          records.push(record);
        }
      }
    }
    if (!records.length) throw new Error('No se encontraron números de ticket completos de 20 dígitos desde la celda B9.');
    return {
      schema: 'soriticket.capture.batch', schemaVersion: 1, appVersion: VERSION,
      fileName: fileName || 'tickets.csv', importedAt: nowIso(), updatedAt: nowIso(),
      defaultBranch: String(branchDefault || '').trim(),
      defaultPurchaseDate: String(purchaseDateDefault || '').trim(),
      nextIndex: 0, runStatus: 'idle', phase: 'idle', currentTicket: '',
      lastMessage: 'Archivo importado. Revisa el lote y pulsa Consultar tickets.', records
    };
  }

  function parseMoney(value) {
    if (value === null || value === undefined) return null;
    const raw = String(value).replace(/\s/g, '').replace(/\$/g, '').replace(/,/g, '');
    if (!raw || /^(null|undefined|nan|-)$/i.test(raw)) return null;
    const n = Number(raw.replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(n) ? n : null;
  }

  function parseQuantity(value) {
    const n = Number(String(value ?? '').replace(/,/g, '').replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(n) ? n : null;
  }

  function labelValue(p) {
    if (!p) return '';
    const label = p.querySelector('span');
    const clone = p.cloneNode(true);
    clone.querySelectorAll('span').forEach(node => node.remove());
    return (clone.textContent || '').trim();
  }

  function parseLabeledRows(container) {
    const result = {};
    if (!container) return result;
    container.querySelectorAll('p').forEach(p => {
      const label = normalize(p.querySelector('span')?.textContent || '');
      const value = labelValue(p);
      if (label) result[label] = value;
    });
    return result;
  }

  function cleanValue(value) {
    const v = String(value ?? '').trim();
    return !v || /^(null|undefined|n\/a|--?)$/i.test(v) ? '' : v;
  }

  // El portal puede incluir sus etiquetas responsivas dentro del texto de cada celda.
  // Se eliminan aquí para que el JSON guarde únicamente el valor, no el nombre de columna.
  function cleanProductCell(value, field) {
    const text = cleanValue(value);
    const labels = {
      code: /^(?:c[oó]digo|sku|clave)\s*(?::|：|\-)?\s*/i,
      quantity: /^(?:cantidad|cant\.?|pzas?\.?|unidades)\s*(?::|：|\-)?\s*/i,
      description: /^(?:descripci[oó]n|art[ií]culo|producto|nombre)\s*(?::|：|\-)?\s*/i,
      unitPrice: /^(?:precio(?:\s+unitario)?|p\.?\s*u\.?)\s*(?::|：|\-)?\s*/i,
      amount: /^(?:importe|total)\s*(?::|：|\-)?\s*/i
    };
    return text.replace(labels[field] || /$^/, '').trim();
  }

  function parseLabeledProductLine(value) {
    const text = String(value ?? '').replace(/[\t\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
    const match = text.match(/^cantidad\s*(?::|：|\-)?\s*(\d+(?:[.,]\d+)?)\s+descripci[oó]n\s*(?::|：|\-)?\s*(.*?)\s+precio(?:\s+unitario)?\s*(?::|：|\-)?\s*\$?(-?\d[\d,]*(?:\.\d{1,4})?)\s+importe\s*(?::|：|\-)?\s*\$?(-?\d[\d,]*(?:\.\d{1,4})?)$/i);
    return match ? { quantityRaw: match[1], description: match[2].trim(), unitPriceRaw: match[3], amountRaw: match[4] } : null;
  }

  function dateToIso(value) {
    const raw = cleanValue(value);
    if (!raw) return '';
    let m = raw.match(/\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/);
    if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    m = raw.match(/\b(\d{1,2})[-/](\d{1,2})[-/](\d{4})\b/);
    if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? raw : parsed.toISOString().slice(0, 10);
  }

  function findMetadata(modal, ticketFields) {
    let branch = '', date = '', time = '';
    const branchKeys = ['sucursal', 'tienda', 'numero de tienda', 'numero de sucursal', 'store'];
    const dateKeys = ['fecha de compra', 'fecha compra', 'fecha del ticket', 'fecha', 'purchase date'];
    const timeKeys = ['hora de compra', 'hora compra', 'hora', 'purchase time'];
    for (const [key, value] of Object.entries(ticketFields)) {
      if (!branch && branchKeys.some(k => key === k || key.startsWith(`${k} `))) branch = cleanValue(value);
      if (!date && dateKeys.some(k => key === k || key.startsWith(`${k} `))) date = cleanValue(value);
      if (!time && timeKeys.some(k => key === k || key.startsWith(`${k} `))) time = cleanValue(value);
    }
    const labeled = [...modal.querySelectorAll('[data-sucursal],[data-branch],[data-purchase-date],[data-date]')];
    for (const node of labeled) {
      branch ||= cleanValue(node.getAttribute('data-sucursal') || node.getAttribute('data-branch'));
      date ||= cleanValue(node.getAttribute('data-purchase-date') || node.getAttribute('data-date'));
    }
    const text = modal.innerText || modal.textContent || '';
    if (!branch) branch = cleanValue(text.match(/(?:sucursal|tienda)\s*(?:n[uú]mero|no\.?|:|#|-)?\s*[:#-]?\s*([^\n|]{2,70})/i)?.[1]);
    if (!date) date = cleanValue(text.match(/(?:fecha\s*(?:de\s*)?(?:compra|ticket))\s*[:#-]?\s*([^\n|]{6,40})/i)?.[1]);
    if (!time) time = cleanValue(text.match(/(?:hora\s*(?:de\s*)?compra)\s*[:#-]?\s*([^\n|]{3,20})/i)?.[1]);
    return { branch, purchaseDate: dateToIso(date), purchaseDateRaw: date, purchaseTime: time };
  }

  function extractPreview(modal, record) {
    const ticketFields = parseLabeledRows(modal.querySelector('.datos-factura-ticket'));
    const series = cleanValue(ticketFields['numero de serie']);
    const portalTicket = cleanValue(ticketFields['numero de ticket']);

    const items = [];
    modal.querySelectorAll('.datos-factura-productos tbody tr').forEach((tr, index) => {
      const cells = [...tr.querySelectorAll('td, th')].map(td => (td.innerText || td.textContent || '').replace(/\s+/g, ' ').trim());
      if (!cells.length) return;
      const combined = parseLabeledProductLine(cells.join(' ')) || parseLabeledProductLine(tr.innerText || tr.textContent || '');
      const code = cleanProductCell(cells[0], 'code');
      const description = combined?.description || cleanProductCell(cells[1], 'description');
      const quantityRaw = cleanProductCell(combined?.quantityRaw ?? cells[2], 'quantity');
      const unitPriceRaw = cleanProductCell(combined?.unitPriceRaw ?? cells[3], 'unitPrice');
      const amountRaw = cleanProductCell(combined?.amountRaw ?? cells[4], 'amount');
      if (!code && !description && !quantityRaw && !unitPriceRaw && !amountRaw) return;
      items.push({
        line: index + 1,
        code,
        description: description || 'Descripción no disponible',
        quantity: parseQuantity(quantityRaw), quantityRaw,
        unitPrice: parseMoney(unitPriceRaw), unitPriceRaw,
        amount: parseMoney(amountRaw), amountRaw,
        department: classifyDepartment(description, code),
        departmentSource: 'automatic_keyword_match'
      });
    });

    const totals = {};
    modal.querySelectorAll('.datos-factura-totales .col-md-2, .datos-factura-totales [class*="col-"]').forEach(col => {
      const label = normalize(col.querySelector('p')?.textContent || '');
      if (!label) return;
      const input = col.querySelector('input[type="hidden"]');
      const display = col.querySelector('.total-qty')?.textContent || '';
      const raw = cleanValue(input?.value) || cleanValue(display);
      totals[label] = { value: parseMoney(raw), raw };
    });
    const metadata = findMetadata(modal, ticketFields);
    const findTicketField = patterns => {
      for (const [label, value] of Object.entries(ticketFields)) {
        if (patterns.some(pattern => pattern.test(label)) && cleanValue(value)) return cleanValue(value);
      }
      return '';
    };
    const paymentMethod = findTicketField([/forma de pago/, /metodo de pago/, /tipo de pago/, /^pago$/]);
    const cashier = findTicketField([/cajero/, /cajera/, /le atendio/, /atendido por/]);
    const points = findTicketField([/puntos.*acumular/, /puntos soriana/, /^puntos$/]);
    const warnings = [];
    if (!items.length) warnings.push('La vista previa no mostró filas de productos en .datos-factura-productos tbody.');
    if (totals.total?.value === null || totals.total?.value === undefined) warnings.push('El total del ticket no apareció o no pudo interpretarse desde el modal.');
    if (!metadata.branch && !record.branch) warnings.push('La sucursal no está expuesta en la vista previa; se requiere el dato predeterminado del lote o corrección en el visor.');
    if (!metadata.purchaseDate && !record.purchaseDate) warnings.push('La fecha de compra no está expuesta en la vista previa; se requiere el dato predeterminado del lote o corrección en el visor.');

    const portalBranch = metadata.branch;
    const portalDate = metadata.purchaseDate;
    return {
      ticketNumber: portalTicket || record.ticketNumber,
      series,
      branch: portalBranch || record.branch || '',
      branchSource: portalBranch ? 'portal_preview' : (record.branch ? 'batch_default' : 'missing'),
      purchaseDate: portalDate || record.purchaseDate || '',
      purchaseDateSource: portalDate ? 'portal_preview' : (record.purchaseDate ? 'batch_default' : 'missing'),
      purchaseDateRaw: metadata.purchaseDateRaw || '',
      purchaseTime: metadata.purchaseTime || '',
      items, totals, paymentMethod, cashier, points, warnings,
      portalLabels: ticketFields
    };
  }

  function detectPortalOutcome() {
    const already = $page('#ticket-facturado-modal');
    if (isVisible(already)) return { kind: 'terminal', status: 'already_invoiced', detail: 'Soriana indicó que el ticket ya está facturado.' };
    const service = $page('#error-servicio-modal');
    const body = normalize(document.body?.innerText || '');
    if (isVisible(service) || /servicio no disponible|no estan disponibles los servicios de facturacion/.test(body)) {
      return { kind: 'terminal', status: 'service_unavailable', detail: 'Soriana informó que el servicio no está disponible.' };
    }
    const errors = [...document.querySelectorAll('#billing-form .invalid-feedback, #service-error-message')]
      .filter(isVisible).map(el => normalize(el.textContent)).join(' | ');
    if (/no se encontro|ticket invalido|ticket no valido|ticket no existe|sin informacion/.test(errors)) {
      return { kind: 'terminal', status: 'not_found', detail: errors.slice(0, 400) };
    }
    return { kind: 'none' };
  }

  function getForm() {
    return {
      form: $page('#billing-form'), input: $page('#billing-ticket-number'),
      previewButton: $page('#previzualizar-factura'), modal: $page('#factura-modal')
    };
  }

  // SORITICKET solo trabaja dentro de la página actual de facturación Soriana.
  // No navega al portal desde otras páginas, no abre pestañas y no cambia de ruta.
  function isCurrentBillingPortal() {
    try {
      return location.origin === 'https://www.soriana.com' && /^\/facturacion/i.test(location.pathname);
    } catch (_) { return false; }
  }

  function isSameBillingDocumentHref(anchor) {
    if (!anchor || !anchor.hasAttribute('href')) return true;
    const raw = String(anchor.getAttribute('href') || '').trim();
    if (!raw || raw === '#') return true;
    try {
      const destination = new URL(raw, location.href);
      return destination.origin === location.origin &&
        destination.pathname === location.pathname &&
        destination.search === location.search;
    } catch (_) { return false; }
  }

  function activateBillingTab() {
    if (!isCurrentBillingPortal()) return false;
    const candidates = [
      document.querySelector('.tab-FacturarCompra'),
      ...document.querySelectorAll('a,button,[role="tab"],[data-toggle="tab"],[data-bs-toggle="tab"],.nav-link')
    ].filter(Boolean);
    const tab = candidates.find(el =>
      el.matches?.('.tab-FacturarCompra') ||
      /factura tu compra|facturar compra/i.test(el.innerText || el.textContent || '')
    );
    if (!tab) return false;
    const target = tab.matches?.('a,button,[role="tab"],[data-toggle="tab"],[data-bs-toggle="tab"]')
      ? tab
      : (tab.querySelector('a,button,[role="tab"],[data-toggle="tab"],[data-bs-toggle="tab"]') || tab);

    // Nunca activar un enlace que cambie de origen, ruta o consulta.
    if (target.matches?.('a') && !isSameBillingDocumentHref(target)) {
      console.warn('[SORITICKET] Se omitió una navegación fuera de la página actual de facturación.');
      return false;
    }
    if (target.matches?.('button') && (target.disabled || String(target.type || '').toLowerCase() === 'submit')) return false;

    // Utilizar APIs de pestañas cuando estén disponibles: no requieren navegar.
    try {
      if (window.bootstrap?.Tab?.getOrCreateInstance) {
        window.bootstrap.Tab.getOrCreateInstance(target).show();
        return true;
      }
    } catch (_) {}
    try {
      const jq = window.jQuery || window.$;
      if (jq && typeof jq(target).tab === 'function') {
        jq(target).tab('show');
        return true;
      }
    } catch (_) {}

    // Fallback para los tabs propios de Soriana. Se cancela la acción por
    // defecto del enlace, por lo que el click no puede cambiar de página.
    try {
      const cancelDefault = event => event.preventDefault();
      target.addEventListener('click', cancelDefault, { capture: true, once: true });
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return true;
    } catch (_) { return false; }
  }

  function setInputValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setter) throw new Error('No se pudo establecer el número de ticket.');
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  // Misma lógica de selección fiscal del automatizador original SORIFACT:
  // localizar el selector DENTRO de #billing-form, usar el setter nativo,
  // disparar input/change/blur y confirmar el valor que conserva el portal.
  function getTicketCfdiSelect() {
    const form = $page('#billing-form');
    if (!form || !isVisible(form)) return null;

    const selects = [...form.querySelectorAll('select')].filter(isVisible);
    const exact = selects.filter(select =>
      select.id === 'billing-uso-cfdi' || select.name === 'usoCfdi'
    );
    if (exact.length) return exact[0];

    // Respaldo del original para cambios menores de ID/nombre.
    return selects.find(select => {
      const group = select.closest('.form-group, .custom-select-group') || select.parentElement;
      const label = normalize([...group.querySelectorAll('label')]
        .map(node => node.textContent || '').join(' '));
      return label.includes('uso de cfdi');
    }) || null;
  }

  function getG03Option(select) {
    if (!select) return null;
    return [...select.options].find(option => {
      const text = normalize(option.textContent);
      const value = normalize(option.value);
      return (/^g03\b/.test(text) && /gastos en general/.test(text)) || value === 'g03';
    }) || null;
  }

  async function setG03ForPreviewOnly(ticketNumber, timeoutMs = FORM_TIMEOUT_MS) {
    const started = Date.now();
    let lastNotice = 0;
    let lastApplyAt = 0;
    let applyAttempts = 0;

    while (Date.now() - started < timeoutMs) {
      if (!state || state.runStatus !== 'running' || pauseRequested) return { kind: 'paused' };

      const outcome = detectPortalOutcome();
      if (outcome.kind === 'terminal') return { kind: 'terminal', outcome };

      const select = getTicketCfdiSelect();
      if (!select || !isVisible(select) || select.disabled || select.options.length <= 1) {
        if (Date.now() - lastNotice >= 5000) {
          setStatus(`Esperando el selector Uso de CFDI del ticket ${ticketNumber}. Se conserva el mismo ticket y se seguirá intentando.`);
          activateBillingTab();
          const currentInput = $page('#billing-ticket-number');
          if (currentInput && isVisible(currentInput) && currentInput.value.trim() !== ticketNumber) {
            setInputValue(currentInput, ticketNumber);
          }
          lastNotice = Date.now();
        }
        await sleep(POLL_MS);
        continue;
      }

      const option = getG03Option(select);
      if (!option) {
        if (Date.now() - lastNotice >= 3000) {
          setStatus(`El selector de Uso de CFDI ya apareció para ${ticketNumber}, pero Soriana aún no carga la opción G03. Esperando las opciones del portal.`);
          lastNotice = Date.now();
        }
        await sleep(POLL_MS);
        continue;
      }

      if (select.value !== option.value) {
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
        if (!setter) throw new Error('No se encontró el setter nativo del selector Uso de CFDI.');
        setter.call(select, option.value);
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
        select.dispatchEvent(new Event('blur', { bubbles: true }));
        applyAttempts += 1;
        lastApplyAt = Date.now();
        console.info('[SORITICKET] G03 aplicado al selector fiscal:', {
          ticket: ticketNumber, value: option.value, text: option.textContent.trim(), attempt: applyAttempts
        });
      }

      // El formulario puede reconstruirse después de change. Se vuelve a
      // localizar el control y se confirma el valor real, como en SORIFACT.
      const confirmed = await waitFor(() => {
        const current = getTicketCfdiSelect();
        const currentOption = current && getG03Option(current);
        if (current && isVisible(current) && !current.disabled && currentOption && current.value === currentOption.value) {
          return { kind: 'confirmed', value: current.value };
        }
        return null;
      }, 10000, true);

      if (confirmed.kind === 'paused') return { kind: 'paused' };
      if (confirmed.kind === 'confirmed') {
        setStatus(`G03 – Gastos en general confirmado por Soriana para el ticket ${ticketNumber}. Preparando vista previa; no se emitirá factura.`);
        return { kind: 'confirmed' };
      }

      // Si Soriana reemplazó o restableció el selector, volver a buscarlo y
      // aplicar G03 mientras siga dentro del tiempo global.
      if (Date.now() - lastApplyAt < 10000) await sleep(POLL_MS);
    }

    return { kind: 'timeout', elapsedMs: Date.now() - started, attempts: applyAttempts };
  }

  async function waitFor(predicate, timeoutMs, stateMustRun = true) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (stateMustRun && (!state || state.runStatus !== 'running' || pauseRequested)) return { kind: 'paused' };
      const result = predicate();
      if (result) return result;
      await sleep(POLL_MS);
    }
    return { kind: 'timeout' };
  }

  async function ensureFormReady() {
    if (!isCurrentBillingPortal()) {
      return { kind: 'wrong_page' };
    }
    const result = await waitFor(() => {
      const e = getForm();
      if (e.form && isVisible(e.form) && e.input && isVisible(e.input) && e.previewButton) return e;
      activateBillingTab();
      return null;
    }, FORM_TIMEOUT_MS);
    return result;
  }

  function shieldEmitButton() {
    const button = $page('#factura-modal #emitir-factura');
    if (!button) return;
    if (!button.disabled) button.disabled = true;
    button.setAttribute('aria-disabled', 'true');
    button.setAttribute('title', 'Deshabilitado en SORITICKET: solo consulta, no factura.');
    button.removeAttribute('data-url');
  }

  function installNoEmissionGuard() {
    const style = document.createElement('style');
    style.id = 'soriticket-no-emission-style';
    style.textContent = `
      #factura-modal #emitir-factura{display:none!important;visibility:hidden!important;pointer-events:none!important}
      #factura-modal .modal-footer::after{content:'Modo de consulta: la emisión de factura está deshabilitada.';display:block;width:100%;font:12px/1.4 Arial,sans-serif;color:#a51d2d;text-align:center;padding:8px}
    `;
    document.head.appendChild(style);
    document.addEventListener('click', event => {
      const target = event.target?.closest?.('#factura-modal #emitir-factura');
      if (!target) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setStatus('Acción bloqueada: SORITICKET funciona únicamente en modo consulta y no emite facturas.');
      console.warn('[SORITICKET] Se bloqueó un intento de pulsar Generar factura.');
    }, true);
    const observer = new MutationObserver(shieldEmitButton);
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'data-url'] });
    shieldEmitButton();
  }

  function closePreviewModal() {
    const modal = $page('#factura-modal');
    if (!modal) return;
    try {
      if (window.jQuery?.fn?.modal) window.jQuery(modal).modal('hide');
      else {
        const close = modal.querySelector('.modal-header .close, [data-dismiss="modal"]');
        close?.click();
        modal.classList.remove('show');
        modal.setAttribute('aria-hidden', 'true');
        modal.removeAttribute('aria-modal');
        modal.style.display = 'none';
      }
    } catch (error) { console.warn('[SORITICKET] No se pudo cerrar el modal:', error); }
    if (!$page('.modal.show')) {
      document.querySelectorAll('.modal-backdrop').forEach(el => el.remove());
      document.body.classList.remove('modal-open');
      document.body.style.removeProperty('padding-right');
    }
  }

  function resetFormForNextTicket() {
    const { form, input, previewButton } = getForm();
    if (!form || !input) { activateBillingTab(); return false; }
    closePreviewModal();
    try { form.reset(); } catch (_) { /* algunos controles son dinámicos */ }
    setInputValue(input, '');
    form.classList.remove('was-validated');
    form.querySelectorAll('.invalid-feedback').forEach(el => { el.textContent = ''; el.classList.remove('d-block'); });
    form.querySelectorAll('.is-invalid').forEach(el => el.classList.remove('is-invalid'));
    if (previewButton) {
      previewButton.disabled = true;
      previewButton.classList.add('d-none');
      previewButton.textContent = 'Consultar ticket';
    }
    return isVisible(form) && isVisible(input);
  }

  function portalPreviewFingerprint(modal) {
    const rows = modal.querySelectorAll('.datos-factura-productos tbody tr').length;
    const total = modal.querySelector('.datos-factura-totales input[name="total"]')?.value ||
      modal.querySelector('.datos-factura-totales .grand-total')?.textContent || '';
    const ticket = modal.querySelector('.datos-factura-ticket')?.innerText || '';
    return `${rows}|${String(total).trim()}|${normalize(ticket)}`;
  }

  async function waitForPreviewStable(modal) {
    let previous = '', stableCount = 0;
    const started = Date.now();
    while (Date.now() - started < PREVIEW_TIMEOUT_MS) {
      if (!state || state.runStatus !== 'running' || pauseRequested) return { kind: 'paused' };
      shieldEmitButton();
      if (isVisible(modal)) {
        const fingerprint = portalPreviewFingerprint(modal);
        const hasData = modal.querySelectorAll('.datos-factura-productos tbody tr').length > 0 ||
          Boolean(cleanValue(modal.querySelector('.datos-factura-totales input[name="total"]')?.value)) ||
          Boolean(cleanValue(modal.querySelector('.datos-factura-totales .grand-total')?.textContent));
        if (hasData && fingerprint === previous) stableCount += 1;
        else stableCount = 0;
        previous = fingerprint;
        if (stableCount >= 2) return { kind: 'ready' };
      }
      await sleep(POLL_MS);
    }
    return isVisible(modal) ? { kind: 'ready', warning: 'La vista previa no alcanzó estabilidad completa antes del límite; se guardó lo visible.' } : { kind: 'timeout' };
  }

  function updateProgress() {
    const records = state?.records || [];
    const total = records.length;
    const captured = records.filter(r => ['captured', 'captured_incomplete'].includes(r.status)).length;
    const duplicate = records.filter(r => r.status === 'duplicate').length;
    const errors = records.filter(r => ['not_found', 'service_unavailable', 'error', 'invalid_format', 'already_invoiced'].includes(r.status)).length;
    $('#sf-total').textContent = String(total);
    $('#sf-captured').textContent = String(captured);
    $('#sf-duplicates').textContent = String(duplicate);
    $('#sf-errors').textContent = String(errors);
    const done = records.filter(r => r.status !== 'pending' && r.status !== 'capturing').length;
    $('#sf-progress-label').textContent = `${done} de ${total} procesados`;
    $('#sf-progress-bar').style.width = `${total ? Math.min(100, done / total * 100) : 0}%`;
    $('#sf-file-name').textContent = state?.fileName || 'Ningún archivo cargado';
    $('#sf-current').textContent = state?.currentTicket ? `Ticket actual: ${state.currentTicket}` : '';
    $('#sf-start').disabled = !state || state.runStatus === 'running' || !records.some(r => r.status === 'pending');
    $('#sf-pause').disabled = state?.runStatus !== 'running';
    $('#sf-export-json').disabled = !state || !records.length;
    $('#sf-clear').disabled = !state || state.runStatus === 'running';
  }

  function setStatus(message) { const el = $('#sf-status'); if (el) el.textContent = message; }

  function renderRecent() {
    const host = $('#sf-results');
    host.replaceChildren();
    (state?.records || []).slice(-8).reverse().forEach(record => {
      const div = document.createElement('div'); div.className = 'sf-result';
      const strong = document.createElement('strong');
      strong.textContent = `${record.ticketNumber} — ${STATUS[record.status] || record.status}`;
      const small = document.createElement('span');
      small.textContent = [record.branch || 'Sucursal no indicada', record.purchaseDate || 'Fecha no indicada', `${record.items?.length || 0} productos`].join(' · ');
      div.append(strong, small); host.appendChild(div);
    });
  }

  function render() { updateProgress(); renderRecent(); }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = filename; anchor.style.display = 'none';
    document.body.appendChild(anchor); anchor.click(); anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function exportJSON() {
    if (!state) return;
    const payload = {
      schema: 'soriticket.archive', schemaVersion: 1,
      application: { name: 'SORITICKET Captura', version: VERSION },
      exportedAt: nowIso(), source: 'Soriana Facturación - vista previa de ticket',
      batch: {
        sourceFile: state.fileName || '', importedAt: state.importedAt || '',
        defaultBranch: state.defaultBranch || '', defaultPurchaseDate: state.defaultPurchaseDate || ''
      },
      summary: {
        total: state.records.length,
        captured: state.records.filter(r => ['captured','captured_incomplete'].includes(r.status)).length,
        incomplete: state.records.filter(r => r.status === 'captured_incomplete').length
      },
      tickets: state.records.map(record => ({
        ticketNumber: record.ticketNumber,
        series: record.series || '',
        branch: record.branch || '', branchSource: record.branchSource || 'missing',
        purchaseDate: record.purchaseDate || '', purchaseDateSource: record.purchaseDateSource || 'missing',
        purchaseDateRaw: record.purchaseDateRaw || '', purchaseTime: record.purchaseTime || '',
        currency: record.currency || 'MXN', status: record.status,
        detail: record.detail || '', sourceRow: record.sourceRow || null,
        capturedAt: record.capturedAt || '',
        items: record.items || [], totals: record.totals || {},
        paymentMethod: record.paymentMethod || '', cashier: record.cashier || '', points: record.points ?? null,
        warnings: record.warnings || []
      }))
    };
    const date = new Date().toISOString().slice(0, 10);
    downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' }), `soriticket_archivo_${date}.json`);
    setStatus(`JSON exportado: ${payload.summary.captured} tickets capturados de ${payload.summary.total} registros.`);
  }

  async function processRecord(index) {
    const record = state.records[index];
    if (!record || record.status !== 'pending') return;
    state.currentTicket = record.ticketNumber;
    state.phase = 'loading_form';
    record.status = 'capturing';
    record.detail = 'Consulta iniciada; no se ha solicitado ni emitido factura.';
    if (!saveState(index)) { state.runStatus = 'paused'; return; }
    render();

    try {
      const formResult = await ensureFormReady();
      if (formResult.kind === 'paused') return;
      if (formResult.kind === 'wrong_page') throw new Error('SORITICKET solo funciona dentro del portal de facturación Soriana. No se abrió otra página ni se realizó ninguna redirección.');
      if (formResult.kind === 'timeout') throw new Error('El formulario de Factura tu Compra no apareció en el tiempo límite. No se abrirá otra página ni se redireccionará.');
      closePreviewModal();
      setInputValue(formResult.input, record.ticketNumber);
      setStatus(`Preparando vista previa del ticket ${record.ticketNumber}…`);
      // Algunas sesiones de Soriana mantienen deshabilitada la vista previa
      // hasta seleccionar un uso CFDI. G03 se fija únicamente en el formulario
      // temporal de consulta; nunca se accede al botón de emisión.
      const cfdiResult = await setG03ForPreviewOnly(record.ticketNumber);
      if (cfdiResult.kind === 'paused') return;
      if (cfdiResult.kind === 'terminal') {
        record.status = cfdiResult.outcome.status;
        record.detail = cfdiResult.outcome.detail;
        state.nextIndex = index + 1;
        state.currentTicket = '';
        state.phase = 'idle';
        saveState(index); render();
        return;
      }
      if (cfdiResult.kind !== 'confirmed') {
        throw new Error(`No se pudo confirmar G03 en el selector de Uso de CFDI después de ${Math.round(cfdiResult.elapsedMs / 1000)} segundos. El botón de vista previa no se activó y no se intentó emitir factura.`);
      }

      const buttonReady = await waitFor(() => {
        const outcome = detectPortalOutcome();
        if (outcome.kind === 'terminal') return outcome;
        const b = $page('#previzualizar-factura');
        if (b && isVisible(b) && !b.disabled) return { kind: 'ready', button: b };
        return null;
      }, PREVIEW_TIMEOUT_MS);
      if (buttonReady.kind === 'paused') return;
      if (buttonReady.kind === 'terminal') {
        record.status = buttonReady.status; record.detail = buttonReady.detail;
        state.nextIndex = index + 1; state.currentTicket = ''; state.phase = 'idle';
        saveState(index); render(); return;
      }
      if (buttonReady.kind === 'timeout') throw new Error('Soriana no habilitó el botón de consulta previa. Verifica que el ticket sea válido y que el perfil permita previsualizar.');

      buttonReady.button.textContent = 'Consultar ticket';
      setStatus(`Consultando ${record.ticketNumber}. El botón de emisión permanece deshabilitado.`);
      buttonReady.button.click();

      const modalResult = await waitFor(() => {
        const outcome = detectPortalOutcome();
        if (outcome.kind === 'terminal') return outcome;
        const modal = $page('#factura-modal');
        if (modal && isVisible(modal)) return { kind: 'modal', modal };
        return null;
      }, PREVIEW_TIMEOUT_MS);
      if (modalResult.kind === 'paused') return;
      if (modalResult.kind === 'terminal') {
        record.status = modalResult.status; record.detail = modalResult.detail;
        state.nextIndex = index + 1; state.currentTicket = ''; state.phase = 'idle';
        saveState(index); render(); return;
      }
      if (modalResult.kind === 'timeout') throw new Error('No apareció el modal de vista previa; no se realizó ninguna emisión.');

      const stable = await waitForPreviewStable(modalResult.modal);
      if (stable.kind === 'paused') return;
      shieldEmitButton();
      const capture = extractPreview(modalResult.modal, record);
      record.ticketNumber = capture.ticketNumber || record.ticketNumber;
      record.series = capture.series;
      record.branch = capture.branch;
      record.branchSource = capture.branchSource;
      record.purchaseDate = capture.purchaseDate;
      record.purchaseDateSource = capture.purchaseDateSource;
      record.purchaseDateRaw = capture.purchaseDateRaw;
      record.purchaseTime = capture.purchaseTime;
      record.items = capture.items;
      record.totals = capture.totals;
      record.paymentMethod = capture.paymentMethod || '';
      record.cashier = capture.cashier || '';
      record.points = capture.points || null;
      record.warnings = [...capture.warnings];
      if (stable.warning) record.warnings.push(stable.warning);
      record.capturedAt = nowIso();
      record.status = record.items.length && cleanValue(record.totals.total?.raw) ? 'captured' : 'captured_incomplete';
      record.detail = record.status === 'captured'
        ? 'Vista previa guardada. No se pulsó Generar factura.'
        : 'Se guardó lo visible, pero faltan datos en la vista previa. No se pulsó Generar factura.';
      state.nextIndex = index + 1;
      state.currentTicket = '';
      state.phase = 'closing_preview';
      if (!saveState(index)) { state.runStatus = 'paused'; return; }
      render();
      closePreviewModal();
      const restored = resetFormForNextTicket();
      state.phase = restored ? 'idle' : 'recovering_form';
      state.lastMessage = `${record.ticketNumber}: ${STATUS[record.status]}.`;
      saveState();
      setStatus(`${state.lastMessage} Continuando con el siguiente ticket; no se emitió factura.`);
      render();
    } catch (error) {
      console.error('[SORITICKET] Error de captura:', error);
      record.status = 'error';
      record.detail = `${String(error?.message || error).slice(0, 450)} No se intentó emitir factura.`;
      record.warnings = [...(record.warnings || []), record.detail];
      state.nextIndex = index + 1;
      state.currentTicket = '';
      state.phase = 'idle';
      if (!saveState(index)) state.runStatus = 'paused';
      closePreviewModal();
      resetFormForNextTicket();
      setStatus(`${record.ticketNumber}: consulta no completada. ${record.detail}`);
      render();
    }
  }

  async function runLoop() {
    if (loopActive) return;
    loopActive = true; pauseRequested = false;
    try {
      while (state?.runStatus === 'running' && !pauseRequested) {
        while (state.nextIndex < state.records.length && state.records[state.nextIndex].status !== 'pending') state.nextIndex += 1;
        if (state.nextIndex >= state.records.length) break;
        const currentIndex = state.nextIndex;
        await processRecord(currentIndex);
        if (state?.runStatus !== 'running' || pauseRequested) break;
      }
      if (state && !pauseRequested && state.runStatus === 'running') {
        state.runStatus = 'finished'; state.phase = 'finished'; state.currentTicket = '';
        state.lastMessage = 'Lote terminado. Exporta el archivo JSON para cargarlo en el visor.';
        saveState(); setStatus(state.lastMessage);
      }
    } finally {
      loopActive = false;
      if (state && pauseRequested) {
        state.runStatus = 'paused'; state.phase = 'paused'; state.lastMessage = 'Lote pausado por el usuario.';
        saveState(); setStatus(state.lastMessage);
      }
      render();
    }
  }

  // ------------------------------- Panel ------------------------------------
  if ($page('#soriticket-capture-panel')) return;
  const panel = document.createElement('aside');
  panel.id = 'soriticket-capture-panel';
  panel.innerHTML = `
    <header class="st-head"><div><strong>SORITICKET CAPTURA</strong><small>v${VERSION} · MODO SOLO CONSULTA</small></div><button id="st-collapse" type="button" aria-label="Contraer">−</button></header>
    <div class="st-body">
      <div class="st-upload"><label for="st-file">Cargar CSV/TXT de tickets</label><input id="st-file" type="file" accept=".csv,.txt,text/csv"></div>
      <div id="sf-file-name" class="st-muted">Ningún archivo cargado</div>
      <div class="st-meta-grid"><label>Sucursal predeterminada<input id="st-branch" type="text" placeholder="Nombre o número de sucursal"></label><label>Fecha de compra predeterminada<input id="st-date" type="date"></label></div>
      <p class="st-note">Estos datos se usan solo cuando Soriana no los incluye en la vista previa. Confirma que correspondan al lote.</p>
      <div class="st-stats"><div><b id="sf-total">0</b><span>Total</span></div><div><b id="sf-captured">0</b><span>Capturados</span></div><div><b id="sf-duplicates">0</b><span>Duplicados</span></div><div><b id="sf-errors">0</b><span>Incidencias</span></div></div>
      <div class="st-actions"><button id="sf-start" class="st-primary" type="button">Consultar tickets</button><button id="sf-pause" type="button" disabled>Pausar</button><button id="sf-export-json" type="button" disabled>Exportar JSON</button><button id="sf-clear" class="st-danger" type="button" disabled>Borrar lote</button></div>
      <div class="st-progress"><div id="sf-progress-bar"></div></div><div id="sf-progress-label" class="st-muted">0 de 0 procesados</div>
      <div id="sf-status" role="status" aria-live="polite">Carga el CSV para comenzar. No se emitirá factura.</div><div id="sf-current" class="st-current"></div>
      <details class="st-details"><summary>Últimos tickets consultados</summary><div id="sf-results"></div></details>
      <div class="st-safety"><b>Protección de emisión activa</b><br>El botón “Generar factura” del modal permanece oculto, deshabilitado y protegido por un bloqueo de eventos. El script únicamente abre la vista previa, extrae la información y cierra el modal. G03, cuando el portal lo requiere, se utiliza solo para habilitar la vista previa.</div>
    </div>`;
  const panelStyle = document.createElement('style');
  panelStyle.textContent = `
    #soriticket-capture-panel{position:fixed;z-index:2147483646;right:14px;bottom:14px;width:380px;max-width:calc(100vw - 20px);max-height:calc(100vh - 22px);overflow:auto;background:#fff;color:#17212b;border:1px solid #d8dee6;border-radius:14px;box-shadow:0 12px 42px #10243a38;font:13px/1.42 Arial,sans-serif}
    #soriticket-capture-panel *{box-sizing:border-box}#soriticket-capture-panel .st-head{position:sticky;top:0;z-index:3;display:flex;align-items:center;justify-content:space-between;background:linear-gradient(115deg,#151e2c,#263c50);color:#fff;padding:13px 15px;border-radius:13px 13px 0 0}
    #soriticket-capture-panel .st-head strong{font-size:14px;letter-spacing:.4px}#soriticket-capture-panel .st-head small{display:block;font-size:10px;opacity:.85;margin-top:2px}#soriticket-capture-panel button{font:inherit;cursor:pointer;border:1px solid #d9e0e7;border-radius:8px;padding:9px 11px;background:#f3f6f9;color:#1e2c3a}#soriticket-capture-panel button:disabled{opacity:.4;cursor:not-allowed}#soriticket-capture-panel #st-collapse{background:transparent;color:#fff;border:0;font-size:20px;padding:0 5px}#soriticket-capture-panel .st-body{padding:13px}
    #soriticket-capture-panel .st-upload label{display:block;font-weight:700;margin-bottom:5px}#soriticket-capture-panel input[type=file]{width:100%;font-size:11px}#soriticket-capture-panel .st-muted{font-size:11px;color:#667583;margin-top:5px}#soriticket-capture-panel .st-meta-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px}#soriticket-capture-panel .st-meta-grid label{font-size:11px;font-weight:700}#soriticket-capture-panel .st-meta-grid input{display:block;width:100%;margin-top:4px;min-width:0;border:1px solid #d4dce5;border-radius:7px;padding:8px;font:12px Arial}#soriticket-capture-panel .st-note{font-size:10px;color:#65717d;margin:6px 0 10px}
    #soriticket-capture-panel .st-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin:10px 0}#soriticket-capture-panel .st-stats>div{background:#f1f4f7;border-radius:8px;padding:8px 3px;text-align:center}#soriticket-capture-panel .st-stats b{display:block;font-size:20px}#soriticket-capture-panel .st-stats span{font-size:10px;color:#667583}#soriticket-capture-panel .st-actions{display:grid;grid-template-columns:1fr 1fr;gap:7px}#soriticket-capture-panel .st-actions button{min-height:36px}#soriticket-capture-panel .st-primary{grid-column:1/-1;background:#176b52;color:#fff;border-color:#176b52;font-weight:700}#soriticket-capture-panel .st-actions #sf-export-json{background:#eaf2ff;color:#194f83}#soriticket-capture-panel .st-danger{background:#fff1f1;color:#a51d2d}
    #soriticket-capture-panel .st-progress{height:7px;background:#e8edf2;border-radius:20px;overflow:hidden;margin-top:12px}#soriticket-capture-panel #sf-progress-bar{height:100%;width:0;background:#27936c;transition:width .2s}#soriticket-capture-panel #sf-status{font-weight:700;padding:9px 0 4px;overflow-wrap:anywhere}#soriticket-capture-panel .st-current{font-size:11px;color:#526170;overflow-wrap:anywhere}#soriticket-capture-panel .st-details{margin-top:10px;border-top:1px solid #e5eaf0;padding-top:9px}#soriticket-capture-panel .st-details summary{cursor:pointer;font-weight:700}#soriticket-capture-panel #sf-results{max-height:190px;overflow:auto;margin-top:6px}#soriticket-capture-panel .sf-result{padding:7px 2px;border-bottom:1px solid #edf0f3;font-size:11px}#soriticket-capture-panel .sf-result strong{display:block}#soriticket-capture-panel .sf-result span{color:#677483}#soriticket-capture-panel .st-safety{margin-top:12px;padding:9px 10px;border-radius:8px;background:#fdf3e8;border:1px solid #f2d5ad;color:#714719;font-size:10px}#soriticket-capture-panel.st-collapsed .st-body{display:none}
    @media(max-width:480px){#soriticket-capture-panel{right:7px;bottom:7px;width:calc(100vw - 14px);max-width:none;max-height:76vh}}
  `;
  document.head.append(panelStyle);
  document.body.append(panel);
  const $ = selector => panel.querySelector(selector);

  $('#st-collapse').addEventListener('click', () => panel.classList.toggle('st-collapsed'));
  $('#st-file').addEventListener('change', async event => {
    const file = event.target.files?.[0]; if (!file) return;
    if (state?.runStatus === 'running') { setStatus('Pausa el lote antes de cargar otro archivo.'); event.target.value = ''; return; }
    try {
      const branch = $('#st-branch').value.trim();
      const date = $('#st-date').value;
      const newState = importCsv(await file.text(), file.name, branch, date);
      if (state?.records?.length && !window.confirm('El nuevo archivo reemplazará el lote actual. ¿Continuar?')) { event.target.value = ''; return; }
      state = newState;
      if (!saveState(null, true)) throw new Error('No se pudo guardar el lote en el almacenamiento del navegador.');
      render();
      setStatus(`Archivo cargado: ${state.records.length} registros. Los códigos repetidos se marcaron; no se consultarán dos veces.`);
    } catch (error) { setStatus(`No se pudo importar el archivo: ${error.message}`); }
    event.target.value = '';
  });

  $('#st-branch').addEventListener('change', () => {
    if (!state || state.runStatus === 'running') return;
    state.defaultBranch = $('#st-branch').value.trim();
    state.records.forEach((r, i) => { if (!r.branch && r.status === 'pending') { r.branch = state.defaultBranch; r.branchSource = state.defaultBranch ? 'batch_default' : 'missing'; } });
    saveState(null, true); setStatus('Sucursal predeterminada actualizada. Se aplicará a tickets sin sucursal en la vista previa.');
  });
  $('#st-date').addEventListener('change', () => {
    if (!state || state.runStatus === 'running') return;
    state.defaultPurchaseDate = $('#st-date').value;
    state.records.forEach((r, i) => { if (!r.purchaseDate && r.status === 'pending') { r.purchaseDate = state.defaultPurchaseDate; r.purchaseDateSource = state.defaultPurchaseDate ? 'batch_default' : 'missing'; } });
    saveState(null, true); setStatus('Fecha predeterminada actualizada. Se aplicará a tickets sin fecha en la vista previa.');
  });

  $('#sf-start').addEventListener('click', () => {
    if (!isCurrentBillingPortal()) {
      setStatus('Este proceso solo puede ejecutarse dentro del portal de facturación Soriana. No se abrirán pestañas ni se realizará ninguna redirección.');
      return;
    }
    if (!state) { setStatus('Primero carga un CSV o TXT.'); return; }
    state.defaultBranch = $('#st-branch').value.trim();
    state.defaultPurchaseDate = $('#st-date').value;
    state.records.forEach(r => {
      if (r.branchSource !== 'portal_preview' && !r.branch) { r.branch = state.defaultBranch; r.branchSource = state.defaultBranch ? 'batch_default' : 'missing'; }
      if (r.purchaseDateSource !== 'portal_preview' && !r.purchaseDate) { r.purchaseDate = state.defaultPurchaseDate; r.purchaseDateSource = state.defaultPurchaseDate ? 'batch_default' : 'missing'; }
    });
    const pending = state.records.filter(r => r.status === 'pending').length;
    if (!pending) { setStatus('No hay tickets pendientes de consulta.'); return; }
    if (!window.confirm(`Se consultarán ${pending} tickets mediante la vista previa de Soriana. El script guardará productos y totales, pero NO pulsará “Generar factura”. ¿Iniciar?`)) return;
    state.runStatus = 'running'; state.phase = 'idle'; state.lastMessage = 'Consulta iniciada en modo solo lectura.';
    if (!saveState(null, true)) { state.runStatus = 'paused'; return; }
    render(); runLoop();
  });
  $('#sf-pause').addEventListener('click', () => {
    if (!state || state.runStatus !== 'running') return;
    pauseRequested = true;
    const currentIndex = state.nextIndex;
    const current = state.records[currentIndex];
    if (current?.status === 'capturing') {
      current.status = 'pending';
      current.detail = 'Consulta pausada por el usuario antes de guardar la vista previa. Se puede reintentar sin riesgo de emitir factura.';
    }
    state.runStatus = 'paused'; state.phase = 'paused'; state.lastMessage = 'Pausa solicitada; no se realizará ninguna emisión.';
    saveState(current?.status === 'pending' ? currentIndex : null); setStatus(state.lastMessage); render();
  });
  $('#sf-export-json').addEventListener('click', exportJSON);
  $('#sf-clear').addEventListener('click', () => {
    if (state?.runStatus === 'running') return;
    if (!window.confirm('¿Eliminar el lote capturado de este navegador?')) return;
    clearStorage(localStore); clearStorage(sessionStore); state = null; render(); setStatus('Lote eliminado del almacenamiento local.');
  });

  installNoEmissionGuard();
  state = loadState();
  if (state) {
    $('#st-branch').value = state.defaultBranch || '';
    $('#st-date').value = state.defaultPurchaseDate || '';
    if (state.runStatus === 'running' || state.records.some(r => r.status === 'capturing')) {
      state.runStatus = 'paused'; state.phase = 'recovered_after_reload'; state.currentTicket = '';
      state.records.forEach(r => { if (r.status === 'capturing') { r.status = 'pending'; r.detail = 'Página recargada durante la vista previa; se puede consultar de nuevo porque no se emite factura.'; } });
      state.lastMessage = 'Lote recuperado después de recargar. Revisa y pulsa Consultar tickets para continuar.';
      saveState(null, true);
    }
    setStatus(state.lastMessage || 'Lote recuperado.');
  }
  render();
  console.info(`[SORITICKET] Captura v${VERSION} lista. Solo permanece en la página actual del portal de facturación; no abre pestañas ni redirecciona. El botón #emitir-factura está bloqueado y oculto.`);
})();
