(function () {
  'use strict';

  var data = window.RADAR;
  var mount = document.getElementById('board');
  var state = {
    view: 'board',
    search: '',
    category: '',
    chain: '',
    watchlistOnly: false,
    sortKey: 'implied',
    sortDirection: 'desc',
    selectedSlug: ''
  };
  var statsAnimated = false;

  function reducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function animateStats(stats) {
    if (statsAnimated) {
      return;
    }
    statsAnimated = true;
    var numbers = stats.querySelectorAll('strong');
    if (reducedMotion() || !window.requestAnimationFrame) {
      return;
    }
    var targets = Array.prototype.map.call(numbers, function (node) {
      return Number(node.textContent);
    });
    var started = null;
    numbers.forEach(function (node) { node.textContent = '0'; });
    function tick(now) {
      if (started === null) {
        started = now;
      }
      var progress = Math.min(1, (now - started) / 600);
      var eased = 1 - Math.pow(1 - progress, 3);
      numbers.forEach(function (node, index) {
        node.textContent = String(progress === 1 ? targets[index] : Math.floor(targets[index] * eased));
      });
      if (progress < 1) {
        window.requestAnimationFrame(tick);
      }
    }
    window.requestAnimationFrame(tick);
  }

  function markRows(table) {
    if (reducedMotion()) {
      return;
    }
    Array.prototype.forEach.call(table.querySelectorAll('tbody tr'), function (row, index) {
      if (index < 24) {
        row.style.setProperty('--i', String(index));
      }
    });
  }

  function element(tag, attributes, children) {
    var node = document.createElement(tag);
    var props = attributes || {};
    Object.keys(props).forEach(function (key) {
      if (key === 'className') {
        node.className = props[key];
      } else if (key === 'text') {
        node.textContent = props[key];
      } else if (key.slice(0, 2) === 'on') {
        node.addEventListener(key.slice(2).toLowerCase(), props[key]);
      } else {
        node.setAttribute(key, props[key]);
      }
    });
    (children || []).forEach(function (child) {
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return node;
  }

  function text(value) {
    return value === null || value === undefined ? '' : String(value);
  }

  function number(value) {
    var parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function fixed(value, digits) {
    return number(value).toFixed(digits);
  }

  function money(value) {
    var amount = number(value);
    var magnitude = Math.abs(amount);
    if (magnitude >= 1000000000) {
      return '$' + (amount / 1000000000).toFixed(2) + 'B';
    }
    if (magnitude >= 1000000) {
      return '$' + (amount / 1000000).toFixed(2) + 'M';
    }
    if (magnitude >= 1000) {
      return '$' + (amount / 1000).toFixed(1) + 'K';
    }
    return '$' + amount.toFixed(0);
  }

  function percent(value) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) {
      return '—';
    }
    var amount = Number(value);
    return (amount > 0 ? '+' : '') + amount.toFixed(2) + '%';
  }

  function rowChains(row) {
    if (Array.isArray(row.chains)) {
      return row.chains;
    }
    if (row.chains) {
      return String(row.chains).split(',').map(function (chain) {
        return chain.trim();
      }).filter(Boolean);
    }
    return [];
  }

  function ageDays(row) {
    return row.age_days === null || row.age_days === undefined || row.age_days === ''
      ? 365
      : Math.max(0, number(row.age_days));
  }

  function ageLabel(row) {
    if (row.age_days === null || row.age_days === undefined || row.age_days === '') {
      return 'Age unknown';
    }
    var days = number(row.age_days);
    return Math.floor(days) + 'd';
  }

  function categoryInfo(row) {
    var categories = data.category_multiples || {};
    return categories[row.category] || categories.Unknown || {
      multiple: data.model && data.model.base_multiple ? data.model.base_multiple : 1,
      comparable_count: 0
    };
  }

  function maturity(age) {
    if (age <= 540) {
      return 0.6 + (0.4 * age / 540);
    }
    if (age <= 1460) {
      return 1 - (0.3 * (age - 540) / 920);
    }
    return 0.7;
  }

  function modelValues(row) {
    var model = data.model || {};
    var change = row.change_7d === null || row.change_7d === undefined
      ? 0
      : number(row.change_7d);
    var clamped = Math.max(-80, Math.min(200, change));
    var growth = 1 + ((clamped / 100) * 0.75);
    var age = ageDays(row);
    var ageMultiplier = maturity(age);
    var breadth = 1 + (0.02 * Math.min(rowChains(row).length, 5));
    var categoryMultiple = number(categoryInfo(row).multiple || model.base_multiple || 1);
    var implied = number(row.tvl_usd) * categoryMultiple * growth * ageMultiplier * breadth;
    return {
      change: change,
      clampedChange: clamped,
      category: categoryMultiple,
      growth: growth,
      maturity: ageMultiplier,
      breadth: breadth,
      implied: implied
    };
  }

  function uniqueValues(rows, getter) {
    var values = [];
    rows.forEach(function (row) {
      getter(row).forEach(function (value) {
        if (value && values.indexOf(value) === -1) {
          values.push(value);
        }
      });
    });
    return values.sort(function (left, right) {
      return left < right ? -1 : left > right ? 1 : 0;
    });
  }

  function optionSelect(label, value, choices, onChange) {
    var select = element('select', { 'aria-label': label });
    var allOption = element('option', { value: '', text: 'All ' + label.toLowerCase() });
    allOption.selected = value === '';
    select.appendChild(allOption);
    choices.forEach(function (choice) {
      var option = element('option', { value: choice, text: choice });
      option.selected = choice === value;
      select.appendChild(option);
    });
    select.addEventListener('change', function () {
      onChange(select.value);
    });
    return select;
  }

  function toolbar(rows) {
    var controls = element('div', { className: 'toolbar' });
    var search = element('input', {
      type: 'search',
      value: state.search,
      placeholder: 'Search name or slug',
      'aria-label': 'Search name or slug'
    });
    search.addEventListener('input', function () {
      state.search = search.value;
      render();
      var freshSearch = mount.querySelector('input[type="search"]');
      freshSearch.focus();
      freshSearch.setSelectionRange(state.search.length, state.search.length);
    });
    controls.appendChild(element('div', { className: 'field search-field' }, [
      element('label', { text: 'Search' }),
      search
    ]));

    var categories = uniqueValues(rows, function (row) {
      return [row.category || 'Unknown'];
    });
    controls.appendChild(element('div', { className: 'field' }, [
      element('label', { text: 'Category' }),
      optionSelect('Category', state.category, categories, function (value) {
        state.category = value;
        render();
      })
    ]));

    var chains = uniqueValues(rows, rowChains);
    controls.appendChild(element('div', { className: 'field' }, [
      element('label', { text: 'Chain' }),
      optionSelect('Chain', state.chain, chains, function (value) {
        state.chain = value;
        render();
      })
    ]));

    var watch = element('input', {
      type: 'checkbox',
      checked: state.watchlistOnly ? 'checked' : null,
      'aria-label': 'Watchlist only'
    });
    watch.checked = state.watchlistOnly;
    watch.addEventListener('change', function () {
      state.watchlistOnly = watch.checked;
      render();
    });
    controls.appendChild(element('label', { className: 'check-field' }, [
      watch,
      element('span', { text: 'Watchlist only' })
    ]));
    return controls;
  }

  function matchingRows() {
    var query = state.search.trim().toLowerCase();
    return (data.rows || []).filter(function (row) {
      var searchable = (text(row.name) + ' ' + text(row.slug)).toLowerCase();
      var categoryMatch = !state.category || (row.category || 'Unknown') === state.category;
      var chainMatch = !state.chain || rowChains(row).indexOf(state.chain) !== -1;
      var watchMatch = !state.watchlistOnly || Boolean(row.watchlist);
      return (!query || searchable.indexOf(query) !== -1) && categoryMatch && chainMatch && watchMatch;
    });
  }

  function sortedRows(rows) {
    var direction = state.sortDirection === 'asc' ? 1 : -1;
    return rows.slice().sort(function (left, right) {
      var leftValues = modelValues(left);
      var rightValues = modelValues(right);
      var leftValue = state.sortKey === 'implied' ? leftValues.implied
        : state.sortKey === 'tvl' ? number(left.tvl_usd)
          : state.sortKey === 'change' ? leftValues.change
            : ageDays(left);
      var rightValue = state.sortKey === 'implied' ? rightValues.implied
        : state.sortKey === 'tvl' ? number(right.tvl_usd)
          : state.sortKey === 'change' ? rightValues.change
            : ageDays(right);
      if (leftValue === rightValue) {
        var leftName = text(left.name);
        var rightName = text(right.name);
        return leftName < rightName ? -1 : leftName > rightName ? 1 : 0;
      }
      return (leftValue - rightValue) * direction;
    });
  }

  function sortHeader(label, key, numeric) {
    var active = state.sortKey === key;
    var directionLabel = active
      ? (state.sortDirection === 'asc' ? 'ascending' : 'descending')
      : 'none';
    var button = element('button', {
      className: 'sort-button',
      type: 'button',
      'aria-sort': directionLabel,
      text: label + (active ? (state.sortDirection === 'asc' ? ' ↑' : ' ↓') : '')
    });
    button.addEventListener('click', function () {
      if (state.sortKey === key) {
        state.sortDirection = state.sortDirection === 'asc' ? 'desc' : 'asc';
      } else {
        state.sortKey = key;
        state.sortDirection = 'desc';
      }
      render();
    });
    return element('th', { className: numeric ? 'number' : '' }, [button]);
  }

  function boardTable(rows) {
    var table = element('table', { className: 'board-table' });
    var head = element('thead');
    var headerRow = element('tr');
    headerRow.appendChild(element('th', { className: 'number', text: 'Rank' }));
    headerRow.appendChild(element('th', { text: 'Protocol' }));
    headerRow.appendChild(element('th', { text: 'Category' }));
    headerRow.appendChild(element('th', { text: 'Chains' }));
    headerRow.appendChild(sortHeader('TVL', 'tvl', true));
    headerRow.appendChild(sortHeader('7 day change', 'change', true));
    headerRow.appendChild(sortHeader('Age', 'age', true));
    headerRow.appendChild(sortHeader('Implied value', 'implied', true));
    headerRow.appendChild(element('th', { text: 'Model breakdown' }));
    head.appendChild(headerRow);
    table.appendChild(head);

    var body = element('tbody');
    var ordered = sortedRows(rows);
    var largest = ordered.reduce(function (maximum, row) {
      return Math.max(maximum, modelValues(row).implied);
    }, 0);
    ordered.forEach(function (row, index) {
      var values = modelValues(row);
      var breakdown = 'C ' + fixed(values.category, 2)
        + ' · G ' + fixed(values.growth, 3)
        + ' · M ' + fixed(values.maturity, 3)
        + ' · B ' + fixed(values.breadth, 2);
      var protocol = element('button', {
        className: 'protocol-button',
        type: 'button',
        text: text(row.name) || text(row.slug)
      });
      protocol.addEventListener('click', function () {
        state.selectedSlug = row.slug;
        render();
      });
      var nameCell = element('td', {}, [
        protocol,
        element('span', { className: 'slug', text: text(row.slug) })
      ]);
      var changeClass = values.change > 0 ? 'number positive'
        : values.change < 0 ? 'number negative' : 'number';
      var impliedCell = element('td', { className: 'number implied-cell' }, [
        element('span', { text: money(values.implied) }),
        element('span', {
          'aria-hidden': 'true',
          style: 'display:block;height:2px;margin-top:3px;max-width:100%;width:' +
            (largest > 0 ? Math.max(0, Math.min(100, values.implied / largest * 100)) : 0) +
            '%;background:rgba(119,221,162,.48);border-radius:2px'
        })
      ]);
      var tr = element('tr', {}, [
        element('td', { className: 'rank-cell', text: String(index + 1) }),
        nameCell,
        element('td', { text: text(row.category) || 'Unknown' }),
        element('td', { text: rowChains(row).join(', ') || '—' }),
        element('td', { className: 'number', text: money(row.tvl_usd) }),
        element('td', { className: changeClass, text: percent(row.change_7d) }),
        element('td', { className: 'number', text: ageLabel(row) }),
        impliedCell,
        element('td', { className: 'breakdown', text: breakdown })
      ]);
      body.appendChild(tr);
    });
    if (!ordered.length) {
      body.appendChild(element('tr', {}, [
        element('td', { className: 'empty', colspan: '9', text: 'No protocols match these filters.' })
      ]));
    }
    table.appendChild(body);
    markRows(table);
    return table;
  }

  function liveTable(rows) {
    var sorted = rows.slice().sort(function (left, right) {
      return number(right.mcap_usd) - number(left.mcap_usd);
    });
    var table = element('table', { className: 'board-table' });
    var header = element('tr', {}, [
      element('th', { className: 'number', text: 'Rank' }),
      element('th', { text: 'Protocol' }),
      element('th', { text: 'Category' }),
      element('th', { text: 'Chains' }),
      element('th', { className: 'number', text: 'Market cap' })
    ]);
    table.appendChild(element('thead', {}, [header]));
    var body = element('tbody');
    sorted.forEach(function (row, index) {
      body.appendChild(element('tr', {}, [
        element('td', { className: 'rank-cell', text: String(index + 1) }),
        element('td', {}, [
          element('strong', { text: text(row.name) || text(row.slug) }),
          element('span', { className: 'slug', text: text(row.slug) })
        ]),
        element('td', { text: text(row.category) || 'Unknown' }),
        element('td', { text: rowChains(row).join(', ') || '—' }),
        element('td', { className: 'number implied-cell', text: money(row.mcap_usd) })
      ]));
    });
    if (!sorted.length) {
      body.appendChild(element('tr', {}, [
        element('td', { className: 'empty', colspan: '5', text: 'No live-token protocols are listed.' })
      ]));
    }
    table.appendChild(body);
    markRows(table);
    return table;
  }

  function modelPanel() {
    var panel = element('section', { className: 'model-panel', 'aria-labelledby': 'model-title' });
    var description = element('div', {}, [
      element('h2', { id: 'model-title', text: 'How the model works' }),
      element('p', { className: 'formula', text: 'Implied equals TVL times category multiple times growth times maturity times breadth.' }),
      element('p', { text: 'Growth uses the seven day change, clamped from minus 80% to plus 200%, with a 0.75 weight.' }),
      element('p', { text: 'Breadth is 1 plus 0.02 times the smaller of the chain count and 5.' }),
      element('p', { text: 'The maturity hump rises from 0.6 at age zero to 1.0 at 540 days, decays toward 0.7 by 1460 days, then stays flat. Unknown age is treated as 365 days and labelled age unknown.' })
    ]);
    var table = element('table', { className: 'category-table' });
    table.appendChild(element('thead', {}, [element('tr', {}, [
      element('th', { text: 'Category' }),
      element('th', { text: 'Multiple' }),
      element('th', { text: 'Live comparables' })
    ])]));
    var body = element('tbody');
    Object.keys(data.category_multiples || {}).sort().forEach(function (category) {
      var info = data.category_multiples[category];
      body.appendChild(element('tr', {}, [
        element('td', { text: category }),
        element('td', { className: 'number', text: fixed(info.multiple, 2) + '×' }),
        element('td', { className: 'number', text: text(info.comparable_count) })
      ]));
    });
    table.appendChild(body);
    panel.appendChild(description);
    panel.appendChild(element('div', {}, [
      element('h3', { text: 'Category multiples' }),
      table
    ]));
    return panel;
  }

  function farmStep(step) {
    if (step && typeof step === 'object') {
      return {
        action: text(step.action || step.step || step.name),
        cost: text(step.cost || step.cost_usd),
        time: text(step.time || step.time_estimate)
      };
    }
    var value = text(step);
    var costAt = value.indexOf(' Cost: ');
    var timeAt = value.lastIndexOf('. Time: ');
    var action = costAt < 0 ? value : value.slice(0, costAt);
    var cost = costAt < 0 ? '—' : value.slice(costAt + 7, timeAt < 0 ? value.length : timeAt);
    var time = timeAt < 0 ? '—' : value.slice(timeAt + 8).replace(/\.$/, '');
    return { action: action, cost: cost || '—', time: time || '—' };
  }

  function detailPanel() {
    var row = (data.rows || []).filter(function (item) {
      return item.slug === state.selectedSlug;
    })[0];
    if (!row) {
      return null;
    }
    var values = modelValues(row);
    var category = categoryInfo(row);
    var backdrop = element('button', {
      className: 'detail-backdrop',
      type: 'button',
      'aria-label': 'Close protocol details'
    });
    backdrop.addEventListener('click', closeDetail);
    var details = element('aside', {
      className: 'detail',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': text(row.name) + ' details'
    });
    var close = element('button', {
      className: 'close-button',
      type: 'button',
      text: 'Close'
    });
    close.addEventListener('click', closeDetail);
    details.appendChild(element('div', { className: 'detail-head' }, [
      element('div', {}, [
        element('div', { className: 'eyebrow', text: 'Rank ' + text(row.rank) + ' / ' + text(data.board_size) }),
        element('h2', { text: text(row.name) }),
        element('div', {
          className: 'detail-meta',
          text: (text(row.category) || 'Unknown') + ' · ' + (rowChains(row).join(', ') || 'chain not listed') + ' · ' + text(row.slug)
        })
      ]),
      close
    ]));
    details.appendChild(element('h3', { text: 'Model inputs and multipliers' }));
    var entries = [
      ['TVL', money(row.tvl_usd)],
      ['Category multiple', fixed(values.category, 4) + '× · ' + text(category.comparable_count) + ' live comparables'],
      ['Seven day change', percent(row.change_7d) + ' · used ' + fixed(values.clampedChange, 2) + '%'],
      ['Growth multiplier', fixed(values.growth, 4) + '×'],
      ['Maturity multiplier', fixed(values.maturity, 4) + '×'],
      ['Breadth multiplier', fixed(values.breadth, 4) + '×'],
      ['Age', ageLabel(row)],
      ['Implied value', money(values.implied)]
    ];
    var inputGrid = element('div', { className: 'input-grid' });
    entries.forEach(function (entry) {
      inputGrid.appendChild(element('div', { className: 'input-row' }, [
        element('span', { text: entry[0] }),
        element('strong', { text: entry[1] })
      ]));
    });
    details.appendChild(inputGrid);
    details.appendChild(element('p', {
      className: 'record-note',
      text: 'This protocol records no token. Model estimates are not guarantees.'
    }));
    details.appendChild(element('h3', { text: 'Farm plan · six steps' }));
    var list = element('ol', { className: 'steps' });
    (row.farm_steps || []).slice(0, 6).forEach(function (step) {
      var parsed = farmStep(step);
      list.appendChild(element('li', {}, [
        element('span', { className: 'step-action', text: parsed.action || 'Step' }),
        element('span', { className: 'step-cost', text: 'Cost: ' + parsed.cost + ' · Time: ' + parsed.time })
      ]));
    });
    details.appendChild(list);
    return [backdrop, details];
  }

  function closeDetail() {
    state.selectedSlug = '';
    render();
  }

  function setView(view) {
    state.view = view;
    render();
  }

  function render() {
    if (!data || !mount) {
      if (mount) {
        mount.textContent = 'Dataset unavailable.';
        mount.className = 'error';
        mount.setAttribute('aria-busy', 'false');
      }
      return;
    }
    mount.textContent = '';
    mount.removeAttribute('aria-busy');
    var shell = element('div', { className: 'shell' });
    var masthead = element('header', { className: 'masthead' }, [
      element('div', { className: 'brand' }, [
        element('span', { className: 'signal', 'aria-hidden': 'true' }),
        element('div', {}, [
          element('div', { className: 'eyebrow', text: 'Token Radar' }),
          element('h1', { text: 'Token Radar, protocol signal board' })
        ])
      ]),
      element('div', { className: 'stamp' }, [
        element('div', { text: 'AS OF 2026-11-14' }),
        element('div', { text: 'SOURCE · DefiLlama' }),
        element('div', { text: 'MODEL · radar-2' })
      ])
    ]);
    shell.appendChild(masthead);

    var stats = element('div', { className: 'stats' }, [
      element('div', { className: 'stat' }, [
        element('strong', { text: '40' }),
        element('span', { text: 'Watchlist' })
      ]),
      element('div', { className: 'stat' }, [
        element('strong', { text: '198' }),
        element('span', { text: 'Board size' })
      ])
    ]);
    shell.appendChild(element('section', { className: 'guide-row' }, [
      element('p', { className: 'guide', text: 'Read the ranked board as a model-based signal: compare TVL, growth, age, and chain breadth, then open a protocol for its inputs.' }),
      stats
    ]));
    animateStats(stats);

    var tabs = element('nav', { className: 'tabs', 'aria-label': 'Protocol views' });
    var boardTab = element('button', {
      className: 'tab',
      type: 'button',
      'aria-selected': state.view === 'board' ? 'true' : 'false',
      text: 'Pre-token board'
    });
    boardTab.addEventListener('click', function () {
      setView('board');
    });
    var liveTab = element('button', {
      className: 'tab',
      type: 'button',
      'aria-selected': state.view === 'live' ? 'true' : 'false',
      text: 'Live'
    });
    liveTab.addEventListener('click', function () {
      setView('live');
    });
    tabs.appendChild(boardTab);
    tabs.appendChild(liveTab);
    shell.appendChild(tabs);

    if (state.view === 'board') {
      var rows = data.rows || [];
      shell.appendChild(toolbar(rows));
      shell.appendChild(element('p', {
        className: 'view-note',
        text: 'Pre-token protocols · implied values are model estimates. Live-token protocols appear in the Live tab and are already trading.'
      }));
      shell.appendChild(element('div', { className: 'table-wrap' }, [boardTable(matchingRows())]));
      shell.appendChild(modelPanel());
    } else {
      shell.appendChild(element('p', {
        className: 'view-note',
        text: 'Already trading · live-token protocols ranked by market cap. This list is separate from the pre-token ranked board.'
      }));
      shell.appendChild(element('div', { className: 'table-wrap' }, [liveTable(data.live || [])]));
    }

    mount.appendChild(shell);
    if (state.selectedSlug) {
      var detail = detailPanel();
      if (detail) {
        mount.appendChild(detail[0]);
        mount.appendChild(detail[1]);
      }
    }
  }

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && state.selectedSlug) {
      closeDetail();
    }
  });

  render();
}());
