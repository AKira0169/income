/* ui.js — rendering and interaction (Paper design system).
   Depends on Store, Exporter, XLSXMini, SqliteStore. */
(function (root) {
  'use strict';

  var S = root.Store;
  var doc = root.document;

  /* ----------------------------------------------------------- DOM helpers */

  function el(tag, props, children) {
    var node = doc.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (key) {
        var value = props[key];
        if (value === null || value === undefined || value === false) return;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key.slice(0, 2) === 'on') node.addEventListener(key.slice(2).toLowerCase(), value);
        else if (value === true) node.setAttribute(key, '');
        else node.setAttribute(key, value);
      });
    }
    append(node, children);
    return node;
  }

  function append(node, children) {
    if (children === null || children === undefined || children === false) return;
    if (Array.isArray(children)) { children.forEach(function (c) { append(node, c); }); return; }
    node.appendChild(children.nodeType ? children : doc.createTextNode(String(children)));
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function money(cents) { return S.formatMoney(cents); }

  /* Whole percents read better, except near zero where rounding would report a
     real movement as no movement at all. */
  function percent(rate) {
    var value = rate * 100;
    return (Math.abs(value) < 9.5 && value !== 0 ? value.toFixed(1) : String(Math.round(value))) + '%';
  }

  function toast(message) {
    var existing = doc.querySelector('.toast');
    if (existing) existing.remove();
    var node = el('div', { class: 'toast', role: 'status', text: message });
    doc.body.appendChild(node);
    setTimeout(function () { node.remove(); }, 3000);
  }

  function download(data, filename, mime) {
    var blob = new Blob([data], { type: mime });
    var url = URL.createObjectURL(blob);
    var link = el('a', { href: url, download: filename });
    doc.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  function confirmDelete(what) { return root.confirm('Delete this ' + what + '? This cannot be undone.'); }

  /* -------------------------------------------------------------- view state */

  var view = {
    tab: 'dashboard', period: S.currentPeriod(), open: {}, history: {},
    booting: true, bootError: null
  };

  function isOpen(key) { return !!view.open[key]; }
  function toggle(key) { view.open[key] = !view.open[key]; render(); }

  /* Every list can be read two ways: the month on screen, which is the working
     view, or the whole history, which is what you go looking for when you want
     to know when something last happened. */
  function isAllTime(key) { return !!view.history[key]; }

  function scopeToggle(key) {
    var all = isAllTime(key);
    function button(label, wanted) {
      return el('button', {
        class: 'scope-btn' + (all === wanted ? ' is-on' : ''),
        'aria-pressed': all === wanted ? 'true' : 'false',
        text: label,
        onclick: function () { view.history[key] = wanted; render(); }
      });
    }
    return el('div', { class: 'scope', role: 'group', 'aria-label': 'How much to show' }, [
      button('This month', false), button('All time', true)
    ]);
  }

  /* Rows for a history table: the same rows as the monthly view, with a ruled
     heading and running total before each new month. */
  function monthGrouped(records, dateKey, colspan, rowFn, pick) {
    var amount = pick || function (r) { return r.amount || 0; };
    var totals = {};
    records.forEach(function (r) {
      var p = S.periodOf(r[dateKey]);
      totals[p] = (totals[p] || 0) + amount(r);
    });

    var out = [];
    var current = null;
    records.forEach(function (r) {
      var p = S.periodOf(r[dateKey]);
      if (p !== current) {
        current = p;
        out.push(el('tr', { class: 'group-row' }, [
          el('td', { colspan: colspan }, [
            el('span', { text: p ? S.periodLabel(p) : 'No date' }),
            el('span', { class: 'group-total num', text: money(totals[p]) })
          ])
        ]));
      }
      out.push(rowFn(r));
    });
    return out;
  }

  /* Rows in a list, month-grouped when the list is showing all time. */
  function listRows(key, records, dateKey, colspan, rowFn, pick) {
    return isAllTime(key)
      ? monthGrouped(records, dateKey, colspan, rowFn, pick)
      : records.map(rowFn);
  }

  /* An entry dated outside the month on screen would otherwise vanish the
     moment it was saved, which reads as "it was not recorded". Follow it. */
  function followDate(dateISO, message) {
    var period = S.periodOf(dateISO);
    if (period && period !== view.period) {
      view.period = period;
      toast(message + ' · showing ' + S.periodLabel(period));
      return;
    }
    toast(message);
  }

  /* The account cell, with how the money moved underneath it. */
  function accountCell(record) {
    var name = accountName(record.accountId);
    return el('td', {}, [
      name ? el('div', { text: name }) : el('span', { class: 'faint', text: 'not linked' }),
      record.method ? el('span', { class: 'cell-sub', text: record.method }) : null
    ]);
  }

  /* ------------------------------------------------------------------ forms */

  /* Selects are built from {value,label} pairs so an account can show its name
     while storing its id, without a second pass to relabel the options. */
  function toOptions(values, labels) {
    return values.map(function (v) {
      return { value: v, label: labels && labels[v] !== undefined ? labels[v] : v };
    });
  }

  function accountOptions(spec) {
    var list = S.state.accounts.map(function (a) { return { value: a.id, label: a.name }; });
    if (!spec.required) {
      list.unshift({ value: '', label: list.length ? '— not linked —' : '— no accounts yet —' });
    }
    return list;
  }

  /* The account you last used for this kind of record. Nearly every entry goes
     to the same place as the one before it, so this is the right default. */
  function lastAccountFor(collection) {
    var list = S.state[collection] || [];
    for (var i = list.length - 1; i >= 0; i--) {
      if (list[i].accountId && S.byId('accounts', list[i].accountId)) return list[i].accountId;
    }
    var first = S.state.accounts[0];
    return first ? first.id : '';
  }

  function optionList(options) {
    return options.map(function (o) { return el('option', { value: o.value, text: o.label }); });
  }

  function buildForm(fields, record) {
    var inputs = {};
    var grid = el('div', { class: 'form-grid' });

    fields.forEach(function (f) {
      var value = record ? record[f.key] : undefined;
      var control, mount = null;
      var id = 'f_' + f.key + '_' + Math.random().toString(36).slice(2, 7);
      var fallback = typeof f.def === 'function' ? f.def() : f.def;
      var given = value !== undefined && value !== null && value !== '';

      if (f.type === 'select' || f.type === 'account') {
        var options = f.type === 'account' ? accountOptions(f) : toOptions(f.options, f.labels);
        control = el('select', { name: f.key }, optionList(options));
        // Option values are always strings; a karat read back from SQLite is a
        // number, and would otherwise look like an unknown option.
        var initial = given ? String(value) : fallback;
        var known = options.some(function (o) { return String(o.value) === initial; });
        // A category that has since been renamed away must still show, or
        // editing an old record would silently retype it.
        if (initial && !known) control.appendChild(el('option', { value: initial, text: initial }));
        control.value = initial || (options.length ? options[0].value : '');
      } else if (f.type === 'date') {
        var picker = root.DatePicker.create({
          value: given ? value : (fallback || ''),
          id: id, name: f.key, required: f.required, label: f.label
        });
        control = picker.value;
        mount = picker.node;
      } else if (f.type === 'money') {
        control = el('input', {
          name: f.key, type: 'text', inputmode: 'decimal', placeholder: f.placeholder || '0.00',
          value: value === undefined || value === null || value === '' ? '' : String(S.toMajor(value).toFixed(2))
        });
      } else if (f.type === 'number') {
        control = el('input', {
          name: f.key, type: 'number', step: f.step || 'any', min: f.min, placeholder: f.placeholder || '',
          value: value === undefined || value === null ? '' : String(value)
        });
      } else if (f.type === 'checkbox') {
        control = el('input', { name: f.key, type: 'checkbox' });
        control.checked = value === undefined ? (f.def !== false) : !!value;
      } else {
        control = el('input', {
          name: f.key, type: 'text',
          placeholder: f.placeholder || '', value: given ? value : (fallback || '')
        });
      }

      if (f.required) control.setAttribute('required', '');
      // The date field keeps its value on a hidden input, so the label points at
      // the visible one the picker already carries the id on.
      if (!mount) control.setAttribute('id', id);
      inputs[f.key] = { control: control, spec: f };
      grid.appendChild(el('div', { class: 'field' + (f.wide ? ' wide' : '') }, [
        el('label', { for: id, text: f.label }), mount || control
      ]));
    });

    function read() {
      var out = {}, valid = true;
      Object.keys(inputs).forEach(function (key) {
        var entry = inputs[key], f = entry.spec;
        var raw = f.type === 'checkbox' ? entry.control.checked : entry.control.value;
        if (f.type === 'money') {
          out[key] = S.parseMoney(raw);
          if (f.required && !String(raw).trim()) valid = false;
        } else if (f.type === 'number') {
          out[key] = String(raw).trim() === '' ? null : Number(raw);
        } else if (f.type === 'checkbox') {
          out[key] = !!raw;
        } else {
          out[key] = typeof raw === 'string' ? raw.trim() : raw;
          if (f.required && !out[key]) valid = false;
        }
      });
      return valid ? out : null;
    }

    function focusFirst() {
      var first = grid.querySelector('input:not([type="hidden"]), select');
      if (first) first.focus();
    }

    return { node: grid, read: read, focusFirst: focusFirst };
  }

  /* An add-form that stays folded away until asked for. This is the main
     de-cluttering move: every tab opens on your data, not on a blank form. */
  function addSection(key, title, addLabel, fields, onSubmit, forceOpen) {
    var open = isOpen(key) || forceOpen;
    var form = open ? buildForm(fields, null) : null;

    return el('section', { class: 'sheet' }, [
      el('div', { class: 'sheet-head' }, [
        el('h2', { text: title }),
        el('div', { class: 'spacer' }),
        el('button', {
          class: open ? 'quiet' : 'primary',
          'aria-expanded': open ? 'true' : 'false',
          text: open ? 'Cancel' : addLabel,
          onclick: function () { toggle(key); }
        })
      ]),
      open ? el('div', { class: 'disclosure-body' }, [
        el('form', {
          onsubmit: function (e) {
            e.preventDefault();
            var data = form.read();
            if (!data) { toast('Fill in the required fields'); return; }
            onSubmit(data);
            render();
          }
        }, [
          form.node,
          el('div', { class: 'btn-row', style: 'margin-top:16px' }, [
            el('button', { class: 'primary', type: 'submit', text: addLabel }),
            el('button', { type: 'button', text: 'Close', onclick: function () { toggle(key); } })
          ])
        ])
      ]) : null
    ]);
  }

  /* Saving a recurring definition can quietly do two other things — fill in the
     months since it started, and adopt the entries it made before it had an
     account. Both are reported, because a balance that moved on its own is
     alarming when it is not explained. */
  function templateToast(saved, added, linked) {
    var parts = [saved];
    if (added) parts.push(S.plural(added, 'entry', 'entries') + ' added');
    if (linked) parts.push(S.plural(linked, 'past entry', 'past entries') + ' linked');
    return parts.join(' · ');
  }

  /* The "set it once" panel, shared by income and bills. Recurring definitions
     are edited rarely, so it stays folded away behind its own summary line. */
  function recurringSection(cfg) {
    var open = isOpen(cfg.key);
    var templates = cfg.templates;
    var perMonth = S.sum(templates.filter(function (t) { return t.active; }), S.monthlyEquivalent);
    var form = open ? buildForm(cfg.fields, null) : null;

    return el('section', { class: 'sheet' }, [
      el('div', { class: 'sheet-head' }, [
        el('h2', { text: cfg.title }),
        el('span', {
          class: 'muted spacer',
          text: templates.length
            ? S.plural(templates.length, cfg.noun) + ' · ' + money(perMonth) + ' a month'
            : 'none set up yet'
        }),
        el('button', {
          'aria-expanded': open ? 'true' : 'false',
          text: open ? 'Hide' : (templates.length ? 'Show' : 'Set up'),
          onclick: function () { toggle(cfg.key); }
        })
      ]),
      open ? el('div', { class: 'sheet-body flush' }, [
        templates.length ? table(cfg.headers, templates.map(cfg.row)) : null,
        el('div', { class: 'disclosure-body' }, [
          el('p', { class: 'muted', style: 'margin-top:0' }, cfg.hint),
          el('form', {
            onsubmit: function (e) {
              e.preventDefault();
              var data = form.read();
              if (!data) { toast('Fill in the required fields'); return; }
              // The month on screen is where this commitment starts; nothing is
              // ever generated before it.
              data.anchor = view.period;
              data.generatedThrough = null;
              var template = S.upsert(cfg.collection, data);
              var linked = S.linkGeneratedTo(cfg.collection, template);
              var added = S.catchUp();
              render();
              toast(templateToast(cfg.saved, added.total, linked));
            }
          }, [
            form.node,
            el('div', { class: 'btn-row', style: 'margin-top:16px' }, [
              el('button', { class: 'primary', type: 'submit', text: cfg.saveLabel })
            ])
          ])
        ])
      ]) : null
    ]);
  }

  function openEditor(title, fields, record, onSave, afterBuild) {
    var form = buildForm(fields, record);
    var dialog = el('dialog', {}, [
      el('form', {
        method: 'dialog',
        onsubmit: function (e) {
          e.preventDefault();
          var data = form.read();
          if (!data) { toast('Fill in the required fields'); return; }
          data.id = record.id;
          // A save that did more than save says so; anything else just saved.
          var message = onSave(data);
          dialog.close(); dialog.remove();
          render();
          toast(typeof message === 'string' && message ? message : 'Saved');
        }
      }, [
        el('div', { class: 'dialog-head', text: title }),
        el('div', { class: 'dialog-body' }, [form.node]),
        el('div', { class: 'dialog-foot' }, [
          el('button', { type: 'button', text: 'Cancel', onclick: function () { dialog.close(); dialog.remove(); } }),
          el('button', { class: 'primary', type: 'submit', text: 'Save changes' })
        ])
      ])
    ]);
    doc.body.appendChild(dialog);
    if (afterBuild) afterBuild(dialog);
    dialog.showModal();
    form.focusFirst();
  }

  function rowActions(onEdit, onDelete) {
    return el('td', { class: 'actions' }, [
      el('button', { class: 'quiet small', text: 'Edit', onclick: onEdit }),
      el('button', { class: 'quiet small danger', text: 'Delete', onclick: onDelete })
    ]);
  }

  function emptyRow(colspan, title, hint) {
    return el('tr', {}, [el('td', { colspan: colspan }, [
      el('div', { class: 'empty' }, [el('strong', { text: title }), hint])
    ])]);
  }

  function table(headers, rows) {
    return el('div', { class: 'table-wrap' }, [
      el('table', {}, [
        el('thead', {}, [el('tr', {}, headers.map(function (h) {
          return el('th', { class: h.num ? 'num' : (h.actions ? 'actions' : null), text: h.label !== undefined ? h.label : h });
        }))]),
        el('tbody', {}, rows)
      ])
    ]);
  }

  /* ------------------------------------------------------------ field specs */

  /* 21 is what most jewellery sold in Egypt is; 24 is bullion and coins. */
  var KARAT_LABELS = { 24: '24k — pure / bullion', 22: '22k', 21: '21k — usual here', 18: '18k', 14: '14k' };

  var FIELDS = {
    income: [
      { key: 'date', label: 'Date', type: 'date', required: true, def: S.todayISO },
      { key: 'source', label: 'Source', type: 'text', placeholder: 'Employer or client', required: true },
      { key: 'category', label: 'Category', type: 'select', options: S.INCOME_CATEGORIES, def: 'Salary' },
      { key: 'amount', label: 'Amount', type: 'money', required: true },
      { key: 'accountId', label: 'Paid into', type: 'account', def: function () { return lastAccountFor('income'); } },
      { key: 'method', label: 'Received via', type: 'select', options: S.PAYMENT_METHODS, def: 'Bank Transfer' },
      { key: 'notes', label: 'Notes', type: 'text', placeholder: 'Optional', wide: true }
    ],
    purchase: [
      { key: 'date', label: 'Date', type: 'date', required: true, def: S.todayISO },
      { key: 'item', label: 'What you bought', type: 'text', placeholder: 'e.g. weekly shop', required: true },
      { key: 'category', label: 'Category', type: 'select', options: S.PURCHASE_CATEGORIES, def: 'Groceries' },
      { key: 'amount', label: 'Amount', type: 'money', required: true },
      { key: 'accountId', label: 'Paid from', type: 'account', def: function () { return lastAccountFor('purchases'); } },
      { key: 'method', label: 'Paid with', type: 'select', options: S.PAYMENT_METHODS, def: 'Card' },
      { key: 'notes', label: 'Notes', type: 'text', placeholder: 'Optional', wide: true }
    ],
    incomeTemplate: [
      { key: 'source', label: 'Source', type: 'text', placeholder: 'e.g. Acme Ltd — salary', required: true },
      { key: 'category', label: 'Category', type: 'select', options: S.INCOME_CATEGORIES, def: 'Salary' },
      { key: 'frequency', label: 'How often', type: 'select', options: S.FREQUENCIES, def: 'Monthly' },
      { key: 'payDay', label: 'Paid on day', type: 'number', min: 1, step: 1, placeholder: '28' },
      { key: 'expected', label: 'Amount', type: 'money', required: true },
      { key: 'accountId', label: 'Paid into', type: 'account', def: function () { return lastAccountFor('income'); } },
      { key: 'method', label: 'Received via', type: 'select', options: S.PAYMENT_METHODS, def: 'Bank Transfer' },
      { key: 'active', label: 'Active', type: 'checkbox', def: true },
      { key: 'notes', label: 'Notes', type: 'text', placeholder: 'Optional', wide: true }
    ],
    template: [
      { key: 'name', label: 'Bill name', type: 'text', placeholder: 'e.g. Electricity', required: true },
      { key: 'category', label: 'Category', type: 'select', options: S.BILL_CATEGORIES, def: 'Electricity' },
      { key: 'provider', label: 'Provider', type: 'text', placeholder: 'Who bills you' },
      { key: 'frequency', label: 'How often', type: 'select', options: S.FREQUENCIES, def: 'Monthly' },
      { key: 'dueDay', label: 'Due day', type: 'number', min: 1, step: 1, placeholder: '1' },
      { key: 'expected', label: 'Typical amount', type: 'money' },
      { key: 'accountId', label: 'Paid from', type: 'account', def: function () { return lastAccountFor('bills'); } },
      { key: 'method', label: 'Paid by', type: 'select', options: S.PAYMENT_METHODS, def: 'Direct Debit' },
      { key: 'active', label: 'Active', type: 'checkbox', def: true }
    ],
    bill: [
      { key: 'name', label: 'Bill', type: 'text', required: true },
      { key: 'category', label: 'Category', type: 'select', options: S.BILL_CATEGORIES, def: 'Electricity' },
      { key: 'provider', label: 'Provider', type: 'text' },
      { key: 'dueDate', label: 'Due date', type: 'date', required: true },
      { key: 'amount', label: 'Amount billed', type: 'money', required: true },
      { key: 'accountId', label: 'Paid from', type: 'account', def: function () { return lastAccountFor('bills'); } },
      { key: 'units', label: 'Units used', type: 'number', placeholder: 'kWh / m³' },
      { key: 'unitRate', label: 'Rate per unit', type: 'number', placeholder: 'e.g. 0.31' },
      { key: 'paidDate', label: 'Date paid', type: 'date' },
      { key: 'method', label: 'Paid by', type: 'select', options: S.PAYMENT_METHODS, def: 'Direct Debit' },
      { key: 'notes', label: 'Notes', type: 'text', wide: true }
    ],
    account: [
      { key: 'name', label: 'Account name', type: 'text', placeholder: 'e.g. Visa, Meeza, Emergency Fund', required: true },
      { key: 'type', label: 'Type', type: 'select', options: S.ACCOUNT_TYPES, def: 'Current Account' },
      { key: 'opening', label: 'Opening balance', type: 'money' },
      { key: 'target', label: 'Target (optional)', type: 'money' },
      { key: 'notes', label: 'Notes', type: 'text', wide: true }
    ],
    gold: [
      { key: 'date', label: 'Date', type: 'date', required: true, def: S.todayISO },
      {
        key: 'direction', label: 'Bought or sold', type: 'select', options: ['buy', 'sell'],
        labels: { buy: 'Bought', sell: 'Sold' }, def: 'buy'
      },
      { key: 'karat', label: 'Karat', type: 'select', options: S.GOLD_KARATS.map(String), labels: KARAT_LABELS, def: '21' },
      { key: 'grams', label: 'Grams', type: 'number', step: '0.001', min: 0, placeholder: 'e.g. 8', required: true },
      { key: 'amount', label: 'Total paid', type: 'money', required: true },
      { key: 'accountId', label: 'Paid from', type: 'account', def: function () { return lastAccountFor('gold'); } },
      { key: 'dealer', label: 'Shop', type: 'text', placeholder: 'Optional' },
      { key: 'notes', label: 'Notes', type: 'text', placeholder: 'Optional', wide: true }
    ]
  };

  /* Movements between accounts. A transfer needs two accounts, so it is only
     offered once there are two to move between. */
  function savingsFields() {
    var directions = S.state.accounts.length > 1 ? ['transfer', 'in', 'out'] : ['in', 'out'];
    return [
      { key: 'date', label: 'Date', type: 'date', required: true, def: S.todayISO },
      {
        key: 'direction', label: 'Movement', type: 'select', options: directions,
        labels: { transfer: 'Transfer between accounts', in: 'Money in (from outside)', out: 'Money out (to outside)' },
        def: directions[0]
      },
      {
        key: 'fromAccountId', label: 'From account', type: 'account',
        def: function () { return lastAccountFor('income'); }
      },
      { key: 'accountId', label: 'To account', type: 'account', def: function () { return defaultSavingsAccount(); } },
      { key: 'amount', label: 'Amount', type: 'money', required: true },
      { key: 'notes', label: 'Notes', type: 'text', placeholder: 'Optional', wide: true }
    ];
  }

  /* Where money put aside tends to go: the first savings-type account. */
  function defaultSavingsAccount() {
    var pot = S.state.accounts.filter(S.isSavingsAccount)[0] || S.state.accounts[0];
    return pot ? pot.id : '';
  }

  /* "From" only means anything for a transfer, so it is hidden otherwise
     rather than left on screen collecting a value nobody asked for. */
  function wireMovementForm(scope) {
    if (!scope) return;
    var direction = scope.querySelector('select[name="direction"]');
    var from = scope.querySelector('select[name="fromAccountId"]');
    var to = scope.querySelector('select[name="accountId"]');
    if (!direction || !from || !to) return;
    var fromField = from.closest('.field');
    var toLabel = to.closest('.field').querySelector('label');

    function sync() {
      var isTransfer = direction.value === 'transfer';
      if (fromField) fromField.style.display = isTransfer ? '' : 'none';
      if (toLabel) toLabel.textContent = direction.value === 'out' ? 'From account' : 'To account';
    }
    direction.addEventListener('change', sync);
    sync();
  }

  function accountName(id) {
    var account = S.byId('accounts', id);
    return account ? account.name : '';
  }

  /* -------------------------------------------------------------- dashboard */

  function figure(label, value, note, negative) {
    return el('div', { class: 'figure' + (negative ? ' is-negative' : '') }, [
      el('div', { class: 'label', text: label }),
      el('div', { class: 'figure-value', text: value }),
      note ? el('div', { class: 'figure-note', text: note }) : null
    ]);
  }

  function trendChart(period) {
    var data = S.trend(period, 6);
    var max = Math.max.apply(null, data.map(function (d) { return Math.max(d.income, d.spent); }).concat([1]));
    return el('div', {}, [
      el('div', { class: 'trend' }, data.map(function (d) {
        return el('div', {
          class: 'trend-col',
          title: S.periodLabel(d.period) + ' — in ' + money(d.income) + ', out ' + money(d.spent)
        }, [
          el('div', { class: 'trend-bars' }, [
            el('div', { class: 'trend-bar in', style: 'height:' + Math.max((d.income / max) * 100, 1) + '%' }),
            el('div', { class: 'trend-bar out', style: 'height:' + Math.max((d.spent / max) * 100, 1) + '%' })
          ]),
          el('div', { class: 'trend-label', text: d.period.slice(5) + '/' + d.period.slice(2, 4) })
        ]);
      })),
      el('div', { class: 'legend' }, [
        el('span', {}, [el('i', { style: 'background:var(--ink-strong)' }), 'Income']),
        el('span', {}, [el('i', { style: 'background:repeating-linear-gradient(45deg,var(--ink-faint) 0 2px,transparent 2px 4px);border:1px solid var(--ink-faint)' }), 'Spent'])
      ])
    ]);
  }

  function categoryBars(records, total) {
    var groups = S.groupByCategory(records).slice(0, 8);
    if (!groups.length) {
      return el('div', { class: 'empty' }, [el('strong', { text: 'Nothing spent yet' }), 'Add bills or purchases to see the breakdown.']);
    }
    var max = groups[0].amount || 1;
    return el('div', { class: 'bars' }, groups.map(function (g) {
      return el('div', { class: 'bar-row' }, [
        el('div', { class: 'bar-name', text: g.category }),
        el('div', { class: 'bar-value', text: money(g.amount) + (total ? '  ' + Math.round((g.amount / total) * 100) + '%' : '') }),
        el('div', { class: 'bar-track' }, [el('div', { class: 'bar-fill', style: 'width:' + ((g.amount / max) * 100) + '%' })])
      ]);
    }));
  }

  function renderDashboard() {
    var period = view.period;
    var s = S.summary(period);
    var upcoming = S.upcomingBills(45);
    var gold = S.goldSummary();

    return el('div', { class: 'stack' }, [
      el('div', { class: 'figures' }, [
        figure('Income', money(s.income), S.plural(S.incomeIn(period).length, 'entry', 'entries')),
        figure('Spent', money(s.spent), S.plural(s.billCount, 'bill') + ', ' + S.plural(S.purchasesIn(period).length, 'purchase')),
        figure('Net', money(s.net), s.net >= 0 ? 'kept this month' : 'overspent', s.net < 0),
        figure('Saved', money(s.savedNet), s.income > 0 ? Math.round(s.savingsRate * 100) + '% of income' : 'no income recorded')
      ]),

      s.overdueCount ? el('div', { class: 'notice danger' }, [
        el('strong', { text: S.plural(s.overdueCount, 'bill') + ' overdue. ' }),
        'Settle them on the Bills tab.'
      ]) : null,

      el('div', { class: 'two-col' }, [
        el('div', { class: 'stack' }, [
          el('section', { class: 'sheet' }, [
            el('div', { class: 'sheet-head' }, [
              el('h2', { text: 'Income vs spending' }),
              el('span', { class: 'muted spacer', text: 'last 6 months' })
            ]),
            el('div', { class: 'sheet-body' }, [trendChart(period)])
          ]),
          el('section', { class: 'sheet' }, [
            el('div', { class: 'sheet-head' }, [
              el('h2', { text: 'Where it went' }),
              el('span', { class: 'muted spacer', text: S.periodLabel(period) })
            ]),
            el('div', { class: 'sheet-body' }, [
              categoryBars(S.billsIn(period).concat(S.purchasesIn(period)), s.spent)
            ])
          ])
        ]),

        el('div', { class: 'stack' }, [
          el('section', { class: 'sheet' }, [
            el('div', { class: 'sheet-head' }, [
              el('h2', { text: 'Overdue & due soon' }),
              el('span', { class: 'muted spacer', text: 'unpaid, through 45 days' })
            ]),
            upcoming.length
              ? el('div', { class: 'sheet-body flush' }, [table(
                [{ label: 'Bill' }, { label: 'Due' }, { label: 'Amount', num: true }],
                upcoming.slice(0, 10).map(function (b) {
                  return el('tr', {}, [
                    el('td', {}, [
                      el('div', { text: b.name }),
                      el('span', { class: 'status ' + (b.overdue ? 'overdue' : 'due'), text: b.overdue ? 'Overdue' : 'Due' })
                    ]),
                    el('td', { class: 'num', text: b.dueDate }),
                    el('td', { class: 'num', text: money(b.amount) })
                  ]);
                })
              )])
              : el('div', { class: 'empty' }, [el('strong', { text: 'Nothing due' }), 'No overdue bills, none due in 45 days.'])
          ]),

          el('section', { class: 'sheet' }, [
            el('div', { class: 'sheet-head' }, [
              el('h2', { text: 'Accounts' }),
              el('span', { class: 'muted spacer num', text: money(S.totalSavings() + gold.value) })
            ]),
            el('div', { class: 'sheet-body' }, [
              S.state.accounts.length
                ? el('div', { class: 'stack-tight' }, S.state.accounts.map(function (a) {
                  var balance = S.accountBalance(a.id);
                  return el('div', {}, [
                    el('div', { class: 'bar-row' }, [
                      el('div', { class: 'bar-name', text: a.name }),
                      el('div', { class: 'bar-value', text: money(balance) })
                    ]),
                    a.target ? el('div', { class: 'progress' }, [
                      el('div', { style: 'width:' + Math.min(100, Math.max(0, (balance / a.target) * 100)) + '%' })
                    ]) : null,
                    a.target ? el('div', { class: 'muted', text: Math.round((balance / a.target) * 100) + '% of ' + money(a.target) }) : null
                  ]);
                }).concat(gold.value ? [el('div', {}, [
                  el('div', { class: 'bar-row' }, [
                    el('div', { class: 'bar-name', text: 'Gold · ' + gold.grams.toFixed(2) + ' g' }),
                    el('div', { class: 'bar-value', text: money(gold.value) })
                  ])
                ])] : []))
                : el('div', { class: 'empty' }, [el('strong', { text: 'No accounts yet' }), 'Add one on the Accounts tab.'])
            ])
          ])
        ])
      ])
    ]);
  }

  /* ----------------------------------------------------------------- income */

  function renderIncome() {
    var period = view.period;
    var all = isAllTime('income');
    var records = S.sortByDateDesc(all ? S.state.income : S.incomeIn(period), 'date');
    var total = S.sum(records, function (r) { return r.amount; });
    var templates = S.state.incomeTemplates;

    function row(r) {
      return el('tr', {}, [
        el('td', { class: 'num', text: r.date }),
        el('td', {}, [
          el('div', { text: r.source }),
          // Generated rows are marked so you can tell what the app filled
          // in from what you entered by hand.
          r.templateId ? el('span', { class: 'cell-sub', text: 'Recurring' }) : null
        ]),
        el('td', { class: 'muted', text: r.category }),
        el('td', { class: 'num', text: money(r.amount) }),
        accountCell(r),
        el('td', { class: 'truncate muted', title: r.notes || '', text: r.notes || '' }),
        rowActions(
          function () { openEditor('Edit income', FIELDS.income, r, function (d) { S.upsert('income', d); }); },
          function () { if (confirmDelete('income entry')) { S.remove('income', r.id); render(); } }
        )
      ]);
    }

    return el('div', { class: 'stack' }, [
      addSection('add-income', 'One-off income', 'Add income', FIELDS.income, function (data) {
        S.upsert('income', data);
        followDate(data.date, 'Income added');
      }, !records.length && !templates.length),

      el('section', { class: 'sheet' }, [
        el('div', { class: 'sheet-head' }, [
          el('h2', { text: all ? 'All income' : S.periodLabel(period) }),
          el('span', { class: 'muted', text: S.plural(records.length, 'entry', 'entries') }),
          el('div', { class: 'spacer' }, [scopeToggle('income')]),
          !all && templates.length ? el('button', {
            text: 'Generate from recurring',
            onclick: function () {
              var made = S.generateIncome(period);
              render();
              toast(made ? 'Added ' + S.plural(made, 'entry', 'entries') : 'Already up to date');
            }
          }) : null,
          el('span', { class: 'num', text: money(total) })
        ]),
        el('div', { class: 'sheet-body flush' }, [table(
          [{ label: 'Date' }, { label: 'Source' }, { label: 'Category' }, { label: 'Amount', num: true },
            { label: 'Account' }, { label: 'Notes' }, { label: '', actions: true }],
          records.length ? listRows('income', records, 'date', 7, row)
            : [emptyRow(7, all ? 'No income recorded yet' : 'No income in ' + S.periodLabel(period),
              all ? 'Everything you add, in any month, is listed here.'
                : templates.length ? 'Nothing is due from your recurring income this month.'
                  : 'Set your salary up once below and it will appear every month on its own.')]
        )])
      ]),

      recurringSection({
        key: 'recurring-income',
        title: 'Recurring income',
        noun: 'source',
        collection: 'incomeTemplates',
        fields: FIELDS.incomeTemplate,
        saveLabel: 'Save recurring income',
        saved: 'Recurring income saved',
        hint: 'Set your salary — or any other regular payment — up once here. Each new month it is ' +
          'entered for you automatically, and you only touch it if the figure changes.',
        headers: [{ label: 'Source' }, { label: 'Category' }, { label: 'How often' },
          { label: 'Paid on', num: true }, { label: 'Amount', num: true }, { label: 'Per month', num: true },
          { label: 'Status' }, { label: '', actions: true }],
        templates: templates,
        row: function (t) {
          return el('tr', {}, [
            el('td', {}, [
              el('div', { text: t.source }),
              t.accountId ? el('span', { class: 'cell-sub', text: 'into ' + accountName(t.accountId) }) : null
            ]),
            el('td', { class: 'muted', text: t.category }),
            el('td', { class: 'muted', text: t.frequency || 'Monthly' }),
            el('td', { class: 'num', text: 'day ' + (t.payDay || 1) }),
            el('td', { class: 'num', text: money(t.expected) }),
            el('td', { class: 'num', title: 'Spread across the year', text: money(S.monthlyEquivalent(t)) }),
            el('td', {}, [el('span', { class: 'status ' + (t.active ? 'paid' : ''), text: t.active ? 'Active' : 'Paused' })]),
            rowActions(
              function () {
                openEditor('Edit recurring income', FIELDS.incomeTemplate, t, function (d) {
                  var linked = S.linkGeneratedTo('incomeTemplates', S.upsert('incomeTemplates', d));
                  return linked
                    ? 'Saved · ' + S.plural(linked, 'past entry', 'past entries') + ' linked to ' + accountName(d.accountId)
                    : null;
                });
              },
              function () { if (confirmDelete('recurring income')) { S.remove('incomeTemplates', t.id); render(); } }
            )
          ]);
        }
      })
    ]);
  }

  /* ------------------------------------------------------------------ bills */

  function inlineNumber(value, onCommit, opts) {
    var options = opts || {};
    var input = el('input', {
      type: 'text', inputmode: 'decimal', value: value,
      'aria-label': options.label || 'value',
      style: 'width:' + (options.width || '90px') + ';text-align:right;padding:4px 8px',
      placeholder: options.placeholder || ''
    });
    input.addEventListener('change', function () { onCommit(input.value); });
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
    return input;
  }

  function billRow(b) {
    var unit = S.METERED[b.category];
    var overdue = S.billIsOverdue(b);
    var statusClass = b.status === 'paid' ? 'paid' : (overdue ? 'overdue' : 'due');
    var statusText = b.status === 'paid' ? 'Paid' : (overdue ? 'Overdue' : 'Unpaid');

    var sub = [b.provider || '', b.accountId ? 'from ' + accountName(b.accountId) : ''].filter(Boolean).join(' · ');

    return el('tr', {}, [
      el('td', {}, [
        el('div', { text: b.name }),
        sub ? el('span', { class: 'cell-sub', text: sub }) : null
      ]),
      el('td', { class: 'muted', text: b.category }),
      el('td', { class: 'num', text: b.dueDate || '—' }),
      el('td', { class: 'num' }, [
        inlineNumber(b.amount ? S.toMajor(b.amount).toFixed(2) : '', function (raw) {
          S.upsert('bills', { id: b.id, amount: S.parseMoney(raw) });
          render();
        }, { label: b.name + ' amount' })
      ]),
      el('td', { class: 'num' }, [
        unit
          ? inlineNumber(b.units === null || b.units === undefined ? '' : String(b.units), function (raw) {
            S.upsert('bills', { id: b.id, units: String(raw).trim() === '' ? null : Number(raw) });
            render();
          }, { width: '72px', placeholder: unit, label: b.name + ' units used' })
          : el('span', { class: 'faint', text: '—' })
      ]),
      el('td', { class: 'muted', text: unit || '' }),
      el('td', {}, [el('span', { class: 'status ' + statusClass, text: statusText })]),
      el('td', { class: 'actions' }, [
        el('button', {
          class: 'quiet small', text: b.status === 'paid' ? 'Unpay' : 'Mark paid',
          onclick: function () {
            S.upsert('bills', b.status === 'paid'
              ? { id: b.id, status: 'unpaid', paidDate: '' }
              : { id: b.id, status: 'paid', paidDate: S.todayISO() });
            render();
          }
        }),
        el('button', {
          class: 'quiet small', text: 'Edit',
          onclick: function () {
            openEditor('Edit bill', FIELDS.bill, b, function (d) { S.upsert('bills', S.normalizeBill(d, b.period)); });
          }
        }),
        el('button', {
          class: 'quiet small danger', text: 'Delete',
          onclick: function () { if (confirmDelete('bill')) { S.remove('bills', b.id); render(); } }
        })
      ])
    ]);
  }

  function renderBills() {
    var period = view.period;
    var all = isAllTime('bills');
    var bills = (all ? S.state.bills.slice() : S.billsIn(period).slice()).sort(function (a, b) {
      // Newest first when reading history, soonest first when working a month.
      return all ? String(b.dueDate).localeCompare(String(a.dueDate))
        : String(a.dueDate).localeCompare(String(b.dueDate));
    });
    var total = S.sum(bills, function (b) { return b.amount; });
    var paid = S.sum(bills.filter(function (b) { return b.status === 'paid'; }), function (b) { return b.amount; });
    var templates = S.state.billTemplates;

    return el('div', { class: 'stack' }, [
      /* This month's bills lead, because that is the monthly job. */
      el('section', { class: 'sheet' }, [
        el('div', { class: 'sheet-head' }, [
          el('h2', { text: all ? 'All bills' : S.periodLabel(period) }),
          el('span', { class: 'muted', text: money(paid) + ' paid of ' + money(total) }),
          el('div', { class: 'spacer' }, [scopeToggle('bills')]),
          !all ? el('button', {
            text: 'Generate from recurring',
            onclick: function () {
              var made = S.generateBills(period);
              render();
              toast(made ? 'Added ' + S.plural(made, 'bill') : 'Already up to date');
            }
          }) : null,
          el('button', {
            class: 'primary', text: 'Add bill',
            onclick: function () {
              openEditor('Add bill', FIELDS.bill, {
                id: null, templateId: null, name: '', category: 'Other', provider: '',
                period: period, dueDate: S.dueDateFor(period, new Date().getDate()),
                amount: 0, accountId: lastAccountFor('bills'),
                units: null, unitRate: null, status: 'unpaid', paidDate: '', method: '', notes: ''
              }, function (d) {
                d.id = null;
                S.upsert('bills', S.normalizeBill(d, period));
              });
            }
          })
        ]),
        el('div', { class: 'sheet-body flush' }, [table(
          [{ label: 'Bill' }, { label: 'Category' }, { label: 'Due' }, { label: 'Amount', num: true },
            { label: 'Units', num: true }, { label: 'Unit' }, { label: 'Status' }, { label: '', actions: true }],
          bills.length ? listRows('bills', bills, 'dueDate', 8, billRow)
            : [emptyRow(8, all ? 'No bills recorded yet' : 'No bills for ' + S.periodLabel(period),
              all ? 'Every bill you record, in any month, is listed here.'
                : templates.length ? 'Nothing is due from your recurring bills this month.'
                  : 'Set your bills up once below — electricity, water, internet — and each month fills itself in.')]
        )])
      ]),

      recurringSection({
        key: 'recurring',
        title: 'Recurring bills',
        noun: 'bill',
        collection: 'billTemplates',
        fields: FIELDS.template,
        saveLabel: 'Save recurring bill',
        saved: 'Recurring bill saved',
        hint: 'Set each bill up once here — what it is, how often, and the typical amount. Each new ' +
          'month it appears above on its own; type in the real figure when the bill arrives.',
        headers: [{ label: 'Bill' }, { label: 'Category' }, { label: 'Provider' }, { label: 'How often' },
          { label: 'Due day', num: true }, { label: 'Typical', num: true }, { label: 'Per month', num: true },
          { label: 'Status' }, { label: '', actions: true }],
        templates: templates,
        row: function (t) {
          return el('tr', {}, [
            el('td', {}, [
              el('div', { text: t.name }),
              t.accountId ? el('span', { class: 'cell-sub', text: 'from ' + accountName(t.accountId) }) : null
            ]),
            el('td', { class: 'muted', text: t.category }),
            el('td', { class: 'muted', text: t.provider || '—' }),
            el('td', { class: 'muted', text: t.frequency || 'Monthly' }),
            el('td', { class: 'num', text: t.dueDay || 1 }),
            el('td', { class: 'num', text: money(t.expected) }),
            el('td', { class: 'num', title: 'Spread across the year', text: money(S.monthlyEquivalent(t)) }),
            el('td', {}, [el('span', { class: 'status ' + (t.active ? 'paid' : ''), text: t.active ? 'Active' : 'Paused' })]),
            rowActions(
              function () {
              openEditor('Edit recurring bill', FIELDS.template, t, function (d) {
                var linked = S.linkGeneratedTo('billTemplates', S.upsert('billTemplates', d));
                return linked
                  ? 'Saved · ' + S.plural(linked, 'past bill') + ' linked to ' + accountName(d.accountId)
                  : null;
              });
            },
              function () { if (confirmDelete('recurring bill')) { S.remove('billTemplates', t.id); render(); } }
            )
          ]);
        }
      })
    ]);
  }

  /* -------------------------------------------------------------- purchases */

  function renderPurchases() {
    var period = view.period;
    var all = isAllTime('purchases');
    var records = S.sortByDateDesc(all ? S.state.purchases : S.purchasesIn(period), 'date');
    var total = S.sum(records, function (r) { return r.amount; });

    function row(r) {
      return el('tr', {}, [
        el('td', { class: 'num', text: r.date }),
        el('td', { text: r.item }),
        el('td', { class: 'muted', text: r.category }),
        el('td', { class: 'num', text: money(r.amount) }),
        accountCell(r),
        el('td', { class: 'truncate muted', title: r.notes || '', text: r.notes || '' }),
        rowActions(
          function () { openEditor('Edit purchase', FIELDS.purchase, r, function (d) { S.upsert('purchases', d); }); },
          function () { if (confirmDelete('purchase')) { S.remove('purchases', r.id); render(); } }
        )
      ]);
    }

    return el('div', { class: 'stack' }, [
      addSection('add-purchase', 'Purchases', 'Add purchase', FIELDS.purchase, function (data) {
        S.upsert('purchases', data);
        followDate(data.date, 'Purchase added');
      }, !records.length),

      el('section', { class: 'sheet' }, [
        el('div', { class: 'sheet-head' }, [
          el('h2', { text: all ? 'All purchases' : S.periodLabel(period) }),
          el('span', { class: 'muted', text: S.plural(records.length, 'item') }),
          el('div', { class: 'spacer' }, [scopeToggle('purchases')]),
          el('span', { class: 'num', text: money(total) })
        ]),
        el('div', { class: 'sheet-body flush' }, [table(
          [{ label: 'Date' }, { label: 'Item' }, { label: 'Category' }, { label: 'Amount', num: true },
            { label: 'Account' }, { label: 'Notes' }, { label: '', actions: true }],
          records.length ? listRows('purchases', records, 'date', 7, row)
            : [emptyRow(7, all ? 'Nothing bought yet' : 'Nothing bought in ' + S.periodLabel(period),
              'Groceries, fuel, clothes — anything that is not a recurring bill.')]
        )])
      ])
    ]);
  }

  /* ---------------------------------------------------------------- savings */

  /* One line of an account's story: where the balance came from. */
  function flowLine(label, amount, negative) {
    if (!amount) return null;
    return el('div', { class: 'flow' + (negative ? ' is-out' : '') }, [
      el('span', { text: label }),
      el('span', { class: 'num', text: (negative ? '−' : '+') + money(amount) })
    ]);
  }

  function accountCard(a) {
    var flows = S.accountFlows(a.id);
    var balance = S.accountBalance(a.id);
    var lines = [
      flowLine('Opening', flows.opening, flows.opening < 0),
      flowLine('Income', flows.income),
      flowLine('Moved in', flows.savedIn),
      flowLine('Purchases', flows.purchases, true),
      flowLine('Bills paid', flows.bills, true),
      flowLine('Gold', flows.gold, true),
      flowLine('Moved out', flows.savedOut, true)
    ].filter(Boolean);

    return el('div', { class: 'account' }, [
      el('div', { class: 'account-top' }, [
        el('div', {}, [
          el('div', { class: 'account-name', text: a.name }),
          el('div', { class: 'muted', text: a.type })
        ]),
        el('div', { class: 'actions', style: 'margin-left:auto' }, [
          el('button', {
            class: 'quiet small', text: 'Edit',
            onclick: function () { openEditor('Edit account', FIELDS.account, a, function (d) { S.upsert('accounts', d); }); }
          }),
          el('button', {
            class: 'quiet small danger', text: 'Delete',
            onclick: function () {
              if (root.confirm('Delete "' + a.name + '" and all of its movements? This cannot be undone.\n\n' +
                'Income, bills and purchases linked to it are kept, but stop counting towards any balance.')) {
                S.remove('accounts', a.id); render();
              }
            }
          })
        ])
      ]),
      el('div', { class: 'account-balance' + (balance < 0 ? ' is-negative' : ''), text: money(balance) }),
      a.target ? el('div', { class: 'progress' }, [
        el('div', { style: 'width:' + Math.min(100, Math.max(0, (balance / a.target) * 100)) + '%' })
      ]) : null,
      a.target ? el('div', { class: 'muted', text: Math.round((balance / a.target) * 100) + '% of ' + money(a.target) + ' target' }) : null,
      lines.length ? el('div', { class: 'flows' }, lines) : el('div', { class: 'muted', text: 'Nothing has moved yet.' })
    ]);
  }

  function movementRow(t) {
    var to = accountName(t.accountId) || '(deleted)';
    var transfer = t.direction === 'transfer';
    var out = t.direction === 'out';
    var where = transfer ? (accountName(t.fromAccountId) || '(deleted)') + ' → ' + to : to;
    var label = transfer ? 'Transfer' : (out ? 'Out' : 'In');

    return el('tr', {}, [
      el('td', { class: 'num', text: t.date }),
      el('td', { text: where }),
      el('td', {}, [el('span', { class: 'status ' + (transfer ? 'due' : (out ? 'overdue' : 'paid')), text: label })]),
      el('td', { class: 'num', text: (out ? '−' : '+') + money(t.amount) }),
      el('td', { class: 'truncate muted', title: t.notes || '', text: t.notes || '' }),
      rowActions(
        function () {
          openEditor('Edit movement', savingsFields(), t,
            function (d) {
              if (d.direction !== 'transfer') d.fromAccountId = '';
              S.upsert('savingsTx', d);
            },
            function (dialog) { wireMovementForm(dialog); });
        },
        function () { if (confirmDelete('movement')) { S.remove('savingsTx', t.id); render(); } }
      )
    ]);
  }

  function renderSavings() {
    var period = view.period;
    var all = isAllTime('movements');
    var accounts = S.state.accounts;
    var txs = S.sortByDateDesc(all ? S.state.savingsTx : S.savingsTxIn(period), 'date');
    var gold = S.goldSummary();

    var moveSection = null;
    if (accounts.length) {
      moveSection = addSection('add-saving', 'Movements between accounts', 'Record movement', savingsFields(), function (data) {
        if (data.direction !== 'transfer') data.fromAccountId = '';
        else if (data.fromAccountId === data.accountId) {
          toast('A transfer needs two different accounts');
          return;
        }
        S.upsert('savingsTx', data);
        followDate(data.date, data.direction === 'transfer' ? 'Transfer recorded'
          : data.direction === 'out' ? 'Withdrawal recorded' : 'Deposit recorded');
      }, !txs.length);
      wireMovementForm(moveSection);
    }

    return el('div', { class: 'stack' }, [
      el('div', { class: 'figures' }, [
        figure('Across all accounts', money(S.totalSavings()), S.plural(accounts.length, 'account')),
        figure('In savings pots', money(S.savingsBalance()),
          S.plural(accounts.filter(S.isSavingsAccount).length, 'pot')),
        figure('Gold', money(gold.value), gold.value ? gold.pure.toFixed(2) + ' g of pure gold' : 'none held'),
        figure('Total worth', money(S.totalSavings() + gold.value), 'accounts and gold together')
      ]),

      el('section', { class: 'sheet' }, [
        el('div', { class: 'sheet-head' }, [
          el('h2', { text: 'Accounts, cards & pots' }),
          el('span', { class: 'muted spacer' },
            'Every income, purchase and paid bill moves one of these balances.'),
          el('button', {
            class: 'primary', text: 'Add account',
            onclick: function () {
              openEditor('Add account', FIELDS.account,
                { id: null, name: '', type: 'Current Account', opening: 0, target: 0, notes: '' },
                function (d) { d.id = null; S.upsert('accounts', d); });
            }
          })
        ]),
        el('div', { class: 'sheet-body' }, [
          accounts.length
            ? el('div', { class: 'accounts' }, accounts.map(accountCard))
            : el('div', { class: 'empty' }, [
              el('strong', { text: 'No accounts yet' }),
              'Add the card your salary lands on, and anywhere you put money aside. ' +
              'Every entry can then say which account it moved.'
            ])
        ])
      ]),

      moveSection,

      el('section', { class: 'sheet' }, [
        el('div', { class: 'sheet-head' }, [
          el('h2', { text: all ? 'All movements' : S.periodLabel(period) }),
          el('span', { class: 'muted', text: S.plural(txs.length, 'movement') }),
          el('div', { class: 'spacer' }, [scopeToggle('movements')])
        ]),
        el('div', { class: 'sheet-body flush' }, [table(
          [{ label: 'Date' }, { label: 'Account' }, { label: 'Movement' }, { label: 'Amount', num: true },
            { label: 'Notes' }, { label: '', actions: true }],
          txs.length ? listRows('movements', txs, 'date', 6, movementRow)
            : [emptyRow(6, all ? 'No movements recorded yet' : 'No movements in ' + S.periodLabel(period),
              accounts.length ? 'Record what you moved from one account to another.' : 'Add an account first.')]
        )])
      ])
    ]);
  }

  /* ------------------------------------------------------------------- gold */

  function goldPriceLine() {
    var snapshot = S.latestGoldPrice();
    var manual = (Number(S.state.settings.goldManualPrice) || 0) > 0;
    var premium = Number(S.state.settings.goldPremium) || 0;

    if (!snapshot && !manual) {
      return el('div', { class: 'empty' }, [
        el('strong', { text: 'No price yet' }),
        S.state.settings.goldSync === false
          ? 'Price syncing is switched off. Turn it on below, or type a price in yourself.'
          : 'Press "Update price" to fetch today\'s rate, or type one in yourself below.'
      ]);
    }

    var note = manual
      ? 'Your own price, used exactly as typed'
      : 'World spot × USD/EGP' + (premium ? ' + ' + premium + '% shop premium' : '')
        + ' · $' + (snapshot.usdPerOz || 0).toFixed(2) + '/oz · E£' + (snapshot.egpPerUsd || 0).toFixed(2) + '/$';

    return el('div', {}, [
      el('div', { class: 'gold-prices' }, S.GOLD_KARATS.map(function (karat) {
        return el('div', { class: 'gold-price' + (karat === 21 ? ' is-lead' : '') }, [
          el('div', { class: 'label', text: karat + 'k' }),
          el('div', { class: 'gold-price-value', text: money(S.goldPricePerGram(karat)) }),
          el('div', { class: 'muted', text: 'per gram' })
        ]);
      })),
      el('p', { class: 'muted', style: 'margin:12px 0 0' },
        note + (manual || !snapshot ? '' : ' · taken ' + snapshot.date))
    ]);
  }

  function goldPriceSettings() {
    var settings = S.state.settings;
    var sync = el('input', { type: 'checkbox' });
    sync.checked = settings.goldSync !== false;
    var premium = el('input', { type: 'number', step: '0.5', min: '0', max: '100', value: String(Number(settings.goldPremium) || 0) });
    var manual = el('input', {
      type: 'text', inputmode: 'decimal',
      value: Number(settings.goldManualPrice) ? String(S.toMajor(settings.goldManualPrice).toFixed(2)) : '',
      placeholder: 'leave empty to use the synced price'
    });

    return el('div', {}, [
      el('p', { class: 'muted', style: 'margin-top:0' },
        'Gold is quoted worldwide in dollars per ounce. This app fetches that figure and the ' +
        'pound rate once a day and works out the price per gram — which is the bourse price, ' +
        'a little under what a shop quotes. The premium closes that gap. If the figure here ' +
        'ever drifts from the board in the shop, type theirs in and nothing is fetched at all.'),
      el('div', { class: 'form-grid' }, [
        settingRow('Update the price online', sync, 'Once a day, when you open the app'),
        settingRow('Shop premium %', premium, 'Starts at 2%, which matched the Cairo boards'),
        settingRow('Your own price for 24k (per gram)', manual, 'Overrides everything above')
      ]),
      el('div', { class: 'btn-row', style: 'margin-top:16px' }, [
        el('button', {
          class: 'primary', text: 'Save price settings',
          onclick: function () {
            settings.goldSync = sync.checked;
            settings.goldPremium = Number(premium.value) || 0;
            settings.goldManualPrice = S.parseMoney(manual.value);
            S.save();
            render();
            toast('Price settings saved');
          }
        })
      ])
    ]);
  }

  /* A plain line of the daily readings — enough to see which way it is going. */
  function goldSparkline() {
    var history = S.state.goldPrices.slice()
      .sort(function (a, b) { return String(a.date).localeCompare(String(b.date)); })
      .slice(-60);
    if (history.length < 2) return null;

    var values = history.map(function (p) { return p.egpPerGram24 || 0; });
    var min = Math.min.apply(null, values);
    var max = Math.max.apply(null, values);
    var span = (max - min) || 1;
    var points = values.map(function (v, i) {
      var x = (i / (values.length - 1)) * 100;
      var y = 30 - ((v - min) / span) * 28 - 1;
      return x.toFixed(2) + ',' + y.toFixed(2);
    }).join(' ');

    var svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 100 30');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('class', 'spark');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Gold price per gram, last ' + history.length + ' readings');
    var line = doc.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    line.setAttribute('points', points);
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', 'currentColor');
    line.setAttribute('stroke-width', '1');
    line.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.appendChild(line);

    return el('div', {}, [
      svg,
      el('div', { class: 'legend' }, [
        el('span', { text: history[0].date + ' · ' + money(min) }),
        el('span', { text: 'now · ' + money(values[values.length - 1]) })
      ])
    ]);
  }

  function renderGold() {
    var period = view.period;
    var all = isAllTime('gold');
    var summary = S.goldSummary();
    var holdings = S.goldHoldings();
    var records = S.sortByDateDesc(all ? S.state.gold : S.goldIn(period), 'date');
    var history = S.sortByDateDesc(S.state.goldPrices, 'date').slice(0, 14);
    var spark = goldSparkline();

    function row(r) {
      var sold = r.direction === 'sell';
      var grams = Number(r.grams) || 0;
      return el('tr', {}, [
        el('td', { class: 'num', text: r.date }),
        el('td', {}, [
          el('span', { class: 'status ' + (sold ? 'overdue' : 'paid'), text: sold ? 'Sold' : 'Bought' }),
          r.dealer ? el('span', { class: 'cell-sub', text: r.dealer }) : null
        ]),
        el('td', { class: 'num', text: (Number(r.karat) || 24) + 'k' }),
        el('td', { class: 'num', text: grams.toFixed(3) + ' g' }),
        el('td', { class: 'num', text: (sold ? '+' : '−') + money(r.amount) }),
        el('td', { class: 'num muted', text: grams ? money(Math.round((r.amount || 0) / grams)) + '/g' : '—' }),
        el('td', {}, [
          accountName(r.accountId)
            ? el('div', { text: accountName(r.accountId) })
            : el('span', { class: 'faint', text: 'not linked' })
        ]),
        rowActions(
          function () {
            openEditor('Edit gold entry', FIELDS.gold, r, function (d) {
              d.karat = Number(d.karat);
              S.upsert('gold', d);
            });
          },
          function () { if (confirmDelete('gold entry')) { S.remove('gold', r.id); render(); } }
        )
      ]);
    }

    return el('div', { class: 'stack' }, [
      el('div', { class: 'figures' }, [
        figure('Gold held', summary.grams.toFixed(2) + ' g', summary.pure.toFixed(2) + ' g pure'),
        figure('Worth today', money(summary.value), summary.price ? 'priced ' + summary.price.date : 'no price yet'),
        figure('Paid for it', money(summary.invested), S.plural(S.state.gold.length, 'entry', 'entries')),
        figure(summary.gain >= 0 ? 'Gain' : 'Loss', money(summary.gain),
          summary.invested ? percent(summary.gainRate) + ' on what you paid' : 'nothing bought yet',
          summary.gain < 0)
      ]),

      el('section', { class: 'sheet' }, [
        el('div', { class: 'sheet-head' }, [
          el('h2', { text: 'Price per gram' }),
          el('span', { class: 'muted spacer' }, S.state.settings.goldSync === false ? 'syncing off' : 'updated once a day'),
          el('button', {
            text: root.GoldPrice.busy ? 'Updating…' : 'Update price',
            disabled: root.GoldPrice.busy,
            onclick: function () {
              toast('Fetching today\'s price…');
              root.GoldPrice.refresh({ manual: true }).then(function (result) {
                render();
                if (result.ok && result.partial) toast('Price updated, partly — ' + result.error);
                else if (result.ok) toast('Price updated');
                else toast(result.error || 'Could not update the price');
              });
            }
          }),
          el('button', {
            'aria-expanded': isOpen('gold-settings') ? 'true' : 'false',
            text: isOpen('gold-settings') ? 'Hide settings' : 'Price settings',
            onclick: function () { toggle('gold-settings'); }
          })
        ]),
        el('div', { class: 'sheet-body' }, [goldPriceLine()]),
        isOpen('gold-settings') ? el('div', { class: 'disclosure-body' }, [goldPriceSettings()]) : null
      ]),

      el('div', { class: 'two-col' }, [
        el('section', { class: 'sheet' }, [
          el('div', { class: 'sheet-head' }, [
            el('h2', { text: 'What you hold' }),
            el('span', { class: 'muted spacer num', text: money(summary.value) })
          ]),
          el('div', { class: 'sheet-body flush' }, [table(
            [{ label: 'Karat' }, { label: 'Grams', num: true }, { label: 'Price / g', num: true }, { label: 'Worth', num: true }],
            holdings.length ? holdings.map(function (h) {
              return el('tr', {}, [
                el('td', { text: h.karat + 'k' }),
                el('td', { class: 'num', text: h.grams.toFixed(3) }),
                el('td', { class: 'num muted', text: money(S.goldPricePerGram(h.karat)) }),
                el('td', { class: 'num', text: money(h.value) })
              ]);
            }) : [emptyRow(4, 'No gold held', 'Record what you bought below and it is valued at today\'s price.')]
          )])
        ]),

        el('section', { class: 'sheet' }, [
          el('div', { class: 'sheet-head' }, [
            el('h2', { text: 'Price history' }),
            el('span', { class: 'muted spacer', text: S.plural(S.state.goldPrices.length, 'reading') })
          ]),
          spark ? el('div', { class: 'sheet-body' }, [spark]) : null,
          el('div', { class: 'sheet-body flush' }, [table(
            [{ label: 'Date' }, { label: '24k / g', num: true }, { label: '$/oz', num: true }, { label: 'E£/$', num: true }],
            history.length ? history.map(function (p) {
              return el('tr', {}, [
                el('td', { class: 'num', text: p.date }),
                el('td', { class: 'num', text: money(p.egpPerGram24) }),
                el('td', { class: 'num muted', text: (p.usdPerOz || 0).toFixed(2) }),
                el('td', { class: 'num muted', text: (p.egpPerUsd || 0).toFixed(2) })
              ]);
            }) : [emptyRow(4, 'Nothing recorded yet', 'Each day you open the app, that day\'s price is kept here.')]
          )])
        ])
      ]),

      addSection('add-gold', 'Gold you bought or sold', 'Add gold', FIELDS.gold, function (data) {
        data.karat = Number(data.karat);
        data.pricePerGram = data.grams ? Math.round((data.amount || 0) / data.grams) : 0;
        S.upsert('gold', data);
        followDate(data.date, data.direction === 'sell' ? 'Sale recorded' : 'Purchase recorded');
      }, !S.state.gold.length),

      el('section', { class: 'sheet' }, [
        el('div', { class: 'sheet-head' }, [
          el('h2', { text: all ? 'All gold entries' : S.periodLabel(period) }),
          el('span', { class: 'muted', text: S.plural(records.length, 'entry', 'entries') }),
          el('div', { class: 'spacer' }, [scopeToggle('gold')])
        ]),
        el('div', { class: 'sheet-body flush' }, [table(
          [{ label: 'Date' }, { label: 'Bought / sold' }, { label: 'Karat', num: true }, { label: 'Grams', num: true },
            { label: 'Amount', num: true }, { label: 'Per gram', num: true }, { label: 'Account' }, { label: '', actions: true }],
          records.length ? listRows('gold', records, 'date', 8, row)
            : [emptyRow(8, all ? 'No gold recorded yet' : 'Nothing in ' + S.periodLabel(period),
              'Every gram you buy is tracked against the live price.')]
        )])
      ])
    ]);
  }

  /* --------------------------------------------------------------- settings */

  function settingRow(label, control, hint) {
    return el('div', { class: 'field' }, [
      el('label', { text: label }), control,
      hint ? el('div', { class: 'muted', text: hint }) : null
    ]);
  }

  function renderSqlConsole() {
    var input = el('textarea', {
      class: 'sql', spellcheck: 'false',
      placeholder: 'SELECT category, SUM(amount)/100.0 AS total\nFROM bills GROUP BY category ORDER BY total DESC'
    });
    var output = el('div', { class: 'sql-out', style: 'margin-top:12px' });

    function run() {
      clear(output);
      var sql = input.value.trim();
      if (!sql) return;
      try {
        var res = root.SqliteStore.query(sql);
        if (!res.rows.length) {
          append(output, el('div', { class: 'empty', text: 'No rows returned.' }));
          return;
        }
        append(output, table(
          res.columns.map(function (c) { return { label: c }; }),
          res.rows.slice(0, 200).map(function (row) {
            return el('tr', {}, row.map(function (cell) {
              return el('td', { text: cell === null ? '—' : String(cell) });
            }));
          })
        ));
        if (res.rows.length > 200) append(output, el('div', { class: 'muted', style: 'padding:8px 16px', text: 'Showing the first 200 of ' + res.rows.length + ' rows.' }));
      } catch (err) {
        append(output, el('div', { class: 'notice danger', style: 'margin:12px', text: err.message }));
      }
    }

    return el('div', {}, [
      el('p', { class: 'muted', style: 'margin-top:0' },
        'Your records live in a real SQLite database. Query it here, or download the .db and open it in any SQLite tool. ' +
        'Read-only: only SELECT, WITH, PRAGMA and EXPLAIN run.'),
      el('div', { class: 'field' }, [el('label', { text: 'SQL' }), input]),
      el('div', { class: 'btn-row', style: 'margin-top:12px' }, [
        el('button', { class: 'primary', text: 'Run query', onclick: run }),
        el('span', { class: 'muted', text: 'Tables: ' + Object.keys(root.SqliteStore.tables).join(', ') })
      ]),
      output
    ]);
  }

  function renderSettings() {
    var settings = S.state.settings;
    var st = S.state;
    var counts = st.income.length + st.bills.length + st.purchases.length + st.savingsTx.length;

    var symbol = el('input', { type: 'text', value: settings.currencySymbol, maxlength: '4' });
    var code = el('input', { type: 'text', value: settings.currencyCode, maxlength: '5' });
    var locale = el('input', { type: 'text', value: settings.locale, placeholder: 'en-US' });
    var goal = el('input', { type: 'number', value: settings.savingsGoalRate, min: '0', max: '100', step: '1' });
    var auto = el('input', { type: 'checkbox' });
    auto.checked = settings.autoGenerate !== false;

    var restoreInput = el('input', { type: 'file', accept: '.json,application/json', style: 'display:none' });
    restoreInput.addEventListener('change', function () {
      var file = restoreInput.files && restoreInput.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var result = S.importJSON(String(reader.result));
          render();
          toast('Restored ' + result.income + ' income, ' + result.bills + ' bills, ' + result.purchases + ' purchases');
        } catch (err) {
          root.alert('That file could not be restored.\n\n' + err.message);
        }
        restoreInput.value = '';
      };
      reader.readAsText(file);
    });

    return el('div', { class: 'stack' }, [
      el('section', { class: 'sheet' }, [
        el('div', { class: 'sheet-head' }, [el('h2', { text: 'Currency & goals' })]),
        el('div', { class: 'sheet-body' }, [
          el('div', { class: 'form-grid' }, [
            settingRow('Currency symbol', symbol, 'Used on screen and in Excel'),
            settingRow('Currency code', code, 'e.g. USD, GBP, EUR, NGN'),
            settingRow('Number locale', locale, 'Controls digit grouping'),
            settingRow('Savings goal', goal, '% of income you aim to save'),
            settingRow('Fill in recurring entries automatically', auto,
              'Your recurring income and bills are entered for you each new month')
          ]),
          el('div', { class: 'btn-row', style: 'margin-top:16px' }, [
            el('button', {
              class: 'primary', text: 'Save settings',
              onclick: function () {
                settings.currencySymbol = symbol.value || '';
                settings.currencyCode = code.value || '';
                settings.locale = locale.value || 'en-US';
                settings.savingsGoalRate = Number(goal.value) || 0;
                settings.autoGenerate = auto.checked;
                S.save();
                // Switching it back on should catch up straight away rather
                // than waiting for the next time the app is opened.
                var added = S.catchUp();
                render();
                toast(added.total
                  ? 'Settings saved · ' + S.plural(added.total, 'entry', 'entries') + ' added'
                  : 'Settings saved');
              }
            })
          ])
        ])
      ]),

      el('section', { class: 'sheet' }, [
        el('div', { class: 'sheet-head' }, [
          el('h2', { text: 'Your data' }),
          el('span', { class: 'muted spacer', text: S.plural(counts, 'record') + ' · stored in SQLite via ' + root.SqliteStore.backend })
        ]),
        el('div', { class: 'sheet-body' }, [
          el('p', { class: 'muted', style: 'margin-top:0' },
            'The database lives inside this browser. Clearing browsing data or moving to another machine will lose it, ' +
            'so download a copy regularly.'),
          el('div', { class: 'btn-row' }, [
            el('button', {
              class: 'primary', text: 'Download database (.db)',
              onclick: function () {
                download(root.SqliteStore.exportBytes(), 'income-tracker-' + S.todayISO() + '.db', 'application/x-sqlite3');
                toast('Database downloaded');
              }
            }),
            el('button', {
              text: 'Download backup (.json)',
              onclick: function () {
                download(S.exportJSON(), 'income-tracker-backup-' + S.todayISO() + '.json', 'application/json');
                toast('Backup downloaded');
              }
            }),
            el('button', {
              text: 'Restore from .json',
              onclick: function () {
                if (!root.confirm('Restoring replaces everything currently stored.\n\nDownload a backup first if you are unsure. Continue?')) return;
                restoreInput.click();
              }
            }),
            restoreInput
          ])
        ])
      ]),

      el('section', { class: 'sheet' }, [
        el('div', { class: 'sheet-head' }, [
          el('h2', { text: 'Query your data' }),
          el('button', {
            class: 'spacer', 'aria-expanded': isOpen('sql') ? 'true' : 'false',
            text: isOpen('sql') ? 'Hide' : 'Open SQL console',
            onclick: function () { toggle('sql'); }
          })
        ]),
        isOpen('sql') ? el('div', { class: 'sheet-body' }, [renderSqlConsole()]) : null
      ]),

      el('section', { class: 'sheet' }, [
        el('div', { class: 'sheet-head' }, [el('h2', { text: 'Danger zone' })]),
        el('div', { class: 'sheet-body' }, [
          el('button', {
            class: 'danger', text: 'Erase all data',
            onclick: function () {
              if (!root.confirm('Erase every income, bill, purchase and savings record?\n\nThis cannot be undone. Download a backup first if you are unsure.')) return;
              if (!root.confirm('Last chance — really erase everything?')) return;
              S.clearAll();
              render();
              toast('All data erased');
            }
          })
        ])
      ])
    ]);
  }

  /* ----------------------------------------------------------------- export */

  function openExportDialog() {
    var period = view.period;
    var year = period.slice(0, 4);
    var choice = el('select', {}, [
      el('option', { value: 'month', text: 'This month — ' + S.periodLabel(period) }),
      el('option', { value: 'year', text: 'This year — ' + year }),
      el('option', { value: 'all', text: 'Everything (all time)' })
    ]);

    var dialog = el('dialog', {}, [
      el('div', { class: 'dialog-head', text: 'Export to Excel' }),
      el('div', { class: 'dialog-body' }, [
        el('div', { class: 'field' }, [el('label', { text: 'What to include' }), choice]),
        el('p', { class: 'muted' },
          'One .xlsx workbook: summary, income, bills, recurring bills, purchases, utility meters, ' +
          'savings accounts and movements, a month-by-month breakdown and a category breakdown. Totals are live formulas.')
      ]),
      el('div', { class: 'dialog-foot' }, [
        el('button', { type: 'button', text: 'Cancel', onclick: function () { dialog.close(); dialog.remove(); } }),
        el('button', {
          class: 'primary', type: 'button', text: 'Download workbook',
          onclick: function () {
            var scope = choice.value === 'month' ? { type: 'month', period: period }
              : choice.value === 'year' ? { type: 'year', year: year } : { type: 'all' };
            try {
              download(root.Exporter.build(scope), root.Exporter.filename(scope),
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
              toast('Workbook downloaded');
            } catch (err) {
              root.alert('The export failed.\n\n' + err.message);
            }
            dialog.close(); dialog.remove();
          }
        })
      ])
    ]);
    doc.body.appendChild(dialog);
    dialog.showModal();
  }

  /* ------------------------------------------------------------------ shell */

  var TABS = [
    { id: 'dashboard', label: 'Dashboard', render: renderDashboard },
    { id: 'income', label: 'Income', render: renderIncome },
    { id: 'bills', label: 'Bills', render: renderBills },
    { id: 'purchases', label: 'Purchases', render: renderPurchases },
    { id: 'savings', label: 'Accounts', render: renderSavings },
    { id: 'gold', label: 'Gold', render: renderGold },
    { id: 'settings', label: 'Settings', render: renderSettings }
  ];

  function periodOptions() {
    var periods = S.activePeriods();
    var current = S.currentPeriod();
    for (var i = -13; i <= 13; i++) {
      var p = S.shiftPeriod(current, i);
      if (periods.indexOf(p) === -1) periods.push(p);
    }
    if (periods.indexOf(view.period) === -1) periods.push(view.period);
    return periods.sort().reverse();
  }

  function renderTopbar() {
    var select = el('select', {
      'aria-label': 'Month',
      onchange: function (e) { view.period = e.target.value; render(); }
    }, periodOptions().map(function (p) {
      return el('option', { value: p, text: S.periodLabel(p) });
    }));
    select.value = view.period;

    return el('header', { class: 'topbar' }, [
      el('div', { class: 'topbar-inner' }, [
        el('div', { class: 'brand' }, [
          el('b', { text: 'Income Tracker' }),
          root.__BUILD__ ? el('span', { title: 'The build you are running', text: root.__BUILD__ }) : null
        ]),
        el('div', { class: 'period-nav' }, [
          el('button', { class: 'quiet', 'aria-label': 'Previous month', text: '‹', onclick: function () { view.period = S.shiftPeriod(view.period, -1); render(); } }),
          select,
          el('button', { class: 'quiet', 'aria-label': 'Next month', text: '›', onclick: function () { view.period = S.shiftPeriod(view.period, 1); render(); } }),
          el('button', { class: 'quiet', text: 'Today', onclick: function () { view.period = S.currentPeriod(); render(); } })
        ]),
        el('button', { class: 'primary', text: 'Export to Excel', onclick: openExportDialog })
      ]),
      el('nav', { class: 'tabs', role: 'tablist' }, TABS.map(function (t) {
        return el('button', {
          class: 'tab', role: 'tab', 'aria-selected': view.tab === t.id ? 'true' : 'false',
          text: t.label,
          onclick: function () { view.tab = t.id; render(); }
        });
      }))
    ]);
  }

  function storageNotice() {
    if (S.storageAvailable) return null;
    return el('div', { class: 'notice danger', style: 'margin-bottom:24px' }, [
      el('strong', { text: 'Nothing is being saved. ' }),
      'This browser is blocking local storage, so anything you enter will be lost when you close the tab. ' +
      'Download a copy of your data from Settings before you leave.'
    ]);
  }

  /* Which tab the page currently shows. Re-rendering in place — saving a row,
     opening a form — must not throw you back to the top; moving to another tab
     must not drop you halfway down it. Those are different situations and the
     scroll position is only worth keeping in the first. */
  var rendered = null;

  function render() {
    var app = doc.getElementById('app');
    var sameTab = rendered === view.tab;
    var scroll = root.scrollY;
    // The calendar hangs outside #app, so it would outlive the field it belongs
    // to if a render happened while it was open.
    root.DatePicker.close();
    clear(app);

    if (view.bootError) {
      append(app, el('main', {}, [el('div', { class: 'boot' }, [
        el('h1', { text: 'Could not start' }),
        el('p', { class: 'muted', text: view.bootError }),
        el('p', { class: 'muted', text: 'Try opening this file in Chrome or Edge.' })
      ])]));
      return;
    }
    if (view.booting) {
      append(app, el('main', {}, [el('div', { class: 'boot' }, [
        el('h1', { text: 'Income Tracker' }),
        el('p', { class: 'muted', text: 'Opening your database…' })
      ])]));
      return;
    }

    var tab = TABS.find(function (t) { return t.id === view.tab; }) || TABS[0];
    append(app, [renderTopbar(), el('main', {}, [storageNotice(), tab.render()])]);
    rendered = view.tab;
    root.scrollTo(0, sameTab ? scroll : 0);
  }

  function init() {
    render(); // boot screen while the engine warms up

    root.SqliteStore.init(root.__SQL_WASM_B64__).then(function (result) {
      S.attachPersistence({
        save: function (state) {
          return root.SqliteStore.save(state).then(function () { return true; }).catch(function () { return false; });
        }
      });
      S.hydrate(result.state, result.backend !== 'memory');
      // Before the first render, so the month opens already filled in.
      var added = S.catchUp();
      view.booting = false;
      if (result.migrated) S.save();
      render();

      /* The price sync is the one thing here that reaches the network, so it
         happens after the app is already usable and never blocks it. Nothing
         announces itself: a quiet update is the point of "once a day". */
      if (root.GoldPrice.isDue()) {
        root.GoldPrice.refresh().then(function (outcome) { if (outcome.ok) render(); });
      }

      if (result.migrated) {
        toast('Moved your existing records into the database');
      } else if (added.total) {
        var parts = [];
        if (added.income) parts.push(S.plural(added.income, 'income entry', 'income entries'));
        if (added.bills) parts.push(S.plural(added.bills, 'bill'));
        toast('Added ' + parts.join(' and ') + ' from your recurring set-up');
      }
    }).catch(function (err) {
      view.booting = false;
      view.bootError = err && err.message ? err.message : String(err);
      render();
    });
  }

  root.UI = { init: init, render: render, view: view };
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init);
  else init();
}(typeof globalThis !== 'undefined' ? globalThis : this));
