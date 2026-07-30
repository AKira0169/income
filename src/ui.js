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

  var view = { tab: 'dashboard', period: S.currentPeriod(), open: {}, booting: true, bootError: null };

  function isOpen(key) { return !!view.open[key]; }
  function toggle(key) { view.open[key] = !view.open[key]; render(); }

  /* ------------------------------------------------------------------ forms */

  function optionList(values) {
    return values.map(function (v) { return el('option', { value: v, text: v }); });
  }

  function buildForm(fields, record) {
    var inputs = {};
    var grid = el('div', { class: 'form-grid' });

    fields.forEach(function (f) {
      var value = record ? record[f.key] : undefined;
      var control;

      if (f.type === 'select') {
        control = el('select', { name: f.key }, optionList(f.options));
        var initial = value !== undefined && value !== null && value !== ''
          ? value : (typeof f.def === 'function' ? f.def() : f.def);
        if (initial && f.options.indexOf(initial) === -1) control.appendChild(el('option', { value: initial, text: initial }));
        control.value = initial || f.options[0];
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
        var initialText = value !== undefined && value !== null && value !== ''
          ? value : (typeof f.def === 'function' ? f.def() : (f.def || ''));
        control = el('input', {
          name: f.key, type: f.type === 'date' ? 'date' : 'text',
          placeholder: f.placeholder || '', value: initialText
        });
      }

      if (f.required) control.setAttribute('required', '');
      var id = 'f_' + f.key + '_' + Math.random().toString(36).slice(2, 7);
      control.setAttribute('id', id);
      inputs[f.key] = { control: control, spec: f };
      grid.appendChild(el('div', { class: 'field' + (f.wide ? ' wide' : '') }, [
        el('label', { for: id, text: f.label }), control
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
      var first = grid.querySelector('input, select');
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
          onSave(data);
          dialog.close(); dialog.remove();
          render();
          toast('Saved');
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

  var FIELDS = {
    income: [
      { key: 'date', label: 'Date', type: 'date', required: true, def: S.todayISO },
      { key: 'source', label: 'Source', type: 'text', placeholder: 'Employer or client', required: true },
      { key: 'category', label: 'Category', type: 'select', options: S.INCOME_CATEGORIES, def: 'Salary' },
      { key: 'amount', label: 'Amount', type: 'money', required: true },
      { key: 'method', label: 'Received via', type: 'select', options: S.PAYMENT_METHODS, def: 'Bank Transfer' },
      { key: 'notes', label: 'Notes', type: 'text', placeholder: 'Optional', wide: true }
    ],
    purchase: [
      { key: 'date', label: 'Date', type: 'date', required: true, def: S.todayISO },
      { key: 'item', label: 'What you bought', type: 'text', placeholder: 'e.g. weekly shop', required: true },
      { key: 'category', label: 'Category', type: 'select', options: S.PURCHASE_CATEGORIES, def: 'Groceries' },
      { key: 'amount', label: 'Amount', type: 'money', required: true },
      { key: 'method', label: 'Paid with', type: 'select', options: S.PAYMENT_METHODS, def: 'Card' },
      { key: 'notes', label: 'Notes', type: 'text', placeholder: 'Optional', wide: true }
    ],
    template: [
      { key: 'name', label: 'Bill name', type: 'text', placeholder: 'e.g. Electricity', required: true },
      { key: 'category', label: 'Category', type: 'select', options: S.BILL_CATEGORIES, def: 'Electricity' },
      { key: 'provider', label: 'Provider', type: 'text', placeholder: 'Who bills you' },
      { key: 'frequency', label: 'How often', type: 'select', options: S.FREQUENCIES, def: 'Monthly' },
      { key: 'dueDay', label: 'Due day', type: 'number', min: 1, step: 1, placeholder: '1' },
      { key: 'expected', label: 'Typical amount', type: 'money' },
      { key: 'method', label: 'Paid by', type: 'select', options: S.PAYMENT_METHODS, def: 'Direct Debit' },
      { key: 'active', label: 'Active', type: 'checkbox', def: true }
    ],
    bill: [
      { key: 'name', label: 'Bill', type: 'text', required: true },
      { key: 'category', label: 'Category', type: 'select', options: S.BILL_CATEGORIES, def: 'Electricity' },
      { key: 'provider', label: 'Provider', type: 'text' },
      { key: 'dueDate', label: 'Due date', type: 'date', required: true },
      { key: 'amount', label: 'Amount billed', type: 'money', required: true },
      { key: 'units', label: 'Units used', type: 'number', placeholder: 'kWh / m³' },
      { key: 'unitRate', label: 'Rate per unit', type: 'number', placeholder: 'e.g. 0.31' },
      { key: 'paidDate', label: 'Date paid', type: 'date' },
      { key: 'method', label: 'Paid by', type: 'select', options: S.PAYMENT_METHODS, def: 'Direct Debit' },
      { key: 'notes', label: 'Notes', type: 'text', wide: true }
    ],
    account: [
      { key: 'name', label: 'Account name', type: 'text', placeholder: 'e.g. Emergency Fund', required: true },
      { key: 'type', label: 'Type', type: 'select', options: S.ACCOUNT_TYPES, def: 'Savings' },
      { key: 'opening', label: 'Opening balance', type: 'money' },
      { key: 'target', label: 'Target (optional)', type: 'money' },
      { key: 'notes', label: 'Notes', type: 'text', wide: true }
    ]
  };

  function savingsFields() {
    var accounts = S.state.accounts;
    return [
      { key: 'date', label: 'Date', type: 'date', required: true, def: S.todayISO },
      {
        key: 'accountId', label: 'Account', type: 'select',
        options: accounts.map(function (a) { return a.id; }), def: accounts.length ? accounts[0].id : ''
      },
      { key: 'direction', label: 'Direction', type: 'select', options: ['in', 'out'], def: 'in' },
      { key: 'amount', label: 'Amount', type: 'money', required: true },
      { key: 'notes', label: 'Notes', type: 'text', placeholder: 'Optional', wide: true }
    ];
  }

  /* Account ids and in/out are storage values; show people words. */
  function relabelSavingsForm(scope) {
    if (!scope) return;
    var accountSelect = scope.querySelector('select[name="accountId"]');
    if (accountSelect) {
      Array.prototype.forEach.call(accountSelect.options, function (opt) {
        var account = S.byId('accounts', opt.value);
        if (account) opt.textContent = account.name;
      });
    }
    var dirSelect = scope.querySelector('select[name="direction"]');
    if (dirSelect) {
      Array.prototype.forEach.call(dirSelect.options, function (opt) {
        opt.textContent = opt.value === 'out' ? 'Withdrawal (out)' : 'Deposit (in)';
      });
    }
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
              el('h2', { text: 'Savings' }),
              el('span', { class: 'muted spacer num', text: money(S.totalSavings()) })
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
                }))
                : el('div', { class: 'empty' }, [el('strong', { text: 'No accounts yet' }), 'Add one on the Savings tab.'])
            ])
          ])
        ])
      ])
    ]);
  }

  /* ----------------------------------------------------------------- income */

  function renderIncome() {
    var period = view.period;
    var records = S.sortByDateDesc(S.incomeIn(period), 'date');
    var total = S.sum(records, function (r) { return r.amount; });

    return el('div', { class: 'stack' }, [
      addSection('add-income', 'Income', 'Add income', FIELDS.income, function (data) {
        S.upsert('income', data);
        toast('Income added');
      }, !records.length),

      el('section', { class: 'sheet' }, [
        el('div', { class: 'sheet-head' }, [
          el('h2', { text: S.periodLabel(period) }),
          el('span', { class: 'muted spacer', text: S.plural(records.length, 'entry', 'entries') }),
          el('span', { class: 'num', text: money(total) })
        ]),
        el('div', { class: 'sheet-body flush' }, [table(
          [{ label: 'Date' }, { label: 'Source' }, { label: 'Category' }, { label: 'Amount', num: true },
            { label: 'Method' }, { label: 'Notes' }, { label: '', actions: true }],
          records.length ? records.map(function (r) {
            return el('tr', {}, [
              el('td', { class: 'num', text: r.date }),
              el('td', { text: r.source }),
              el('td', { class: 'muted', text: r.category }),
              el('td', { class: 'num', text: money(r.amount) }),
              el('td', { class: 'muted', text: r.method || '—' }),
              el('td', { class: 'truncate muted', title: r.notes || '', text: r.notes || '' }),
              rowActions(
                function () { openEditor('Edit income', FIELDS.income, r, function (d) { S.upsert('income', d); }); },
                function () { if (confirmDelete('income entry')) { S.remove('income', r.id); render(); } }
              )
            ]);
          }) : [emptyRow(7, 'No income in ' + S.periodLabel(period), 'Add your salary, invoices, or any other money in.')]
        )])
      ])
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

    return el('tr', {}, [
      el('td', {}, [
        el('div', { text: b.name }),
        b.provider ? el('span', { class: 'cell-sub', text: b.provider }) : null
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
    var bills = S.billsIn(period).slice().sort(function (a, b) {
      return String(a.dueDate).localeCompare(String(b.dueDate));
    });
    var total = S.sum(bills, function (b) { return b.amount; });
    var paid = S.sum(bills.filter(function (b) { return b.status === 'paid'; }), function (b) { return b.amount; });
    var templates = S.state.billTemplates;
    var perMonth = S.sum(templates.filter(function (t) { return t.active; }), S.monthlyEquivalent);
    var showRecurring = isOpen('recurring');

    return el('div', { class: 'stack' }, [
      /* This month's bills lead, because that is the monthly job. */
      el('section', { class: 'sheet' }, [
        el('div', { class: 'sheet-head' }, [
          el('h2', { text: S.periodLabel(period) }),
          el('span', { class: 'muted spacer', text: money(paid) + ' paid of ' + money(total) }),
          el('button', {
            text: 'Generate from recurring',
            onclick: function () {
              var made = S.generateBills(period);
              render();
              toast(made ? 'Added ' + S.plural(made, 'bill') : 'Already up to date');
            }
          }),
          el('button', {
            class: 'primary', text: 'Add bill',
            onclick: function () {
              openEditor('Add bill', FIELDS.bill, {
                id: null, templateId: null, name: '', category: 'Other', provider: '',
                period: period, dueDate: S.dueDateFor(period, new Date().getDate()),
                amount: 0, units: null, unitRate: null, status: 'unpaid', paidDate: '', method: '', notes: ''
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
          bills.length ? bills.map(billRow)
            : [emptyRow(8, 'No bills for ' + S.periodLabel(period),
              templates.length ? 'Use "Generate from recurring" to create this month\'s bills.'
                : 'Set up your recurring bills below — electricity, water, internet — then generate them each month.')]
        )])
      ]),

      /* Recurring definitions are set up rarely, so they stay folded. */
      el('section', { class: 'sheet' }, [
        el('div', { class: 'sheet-head' }, [
          el('h2', { text: 'Recurring bills' }),
          el('span', {
            class: 'muted spacer',
            text: templates.length ? S.plural(templates.length, 'bill') + ' · ' + money(perMonth) + ' a month' : 'none set up yet'
          }),
          el('button', {
            'aria-expanded': showRecurring ? 'true' : 'false',
            text: showRecurring ? 'Hide' : (templates.length ? 'Show' : 'Set up'),
            onclick: function () { toggle('recurring'); }
          })
        ]),
        showRecurring ? el('div', { class: 'sheet-body flush' }, [
          templates.length ? table(
            [{ label: 'Bill' }, { label: 'Category' }, { label: 'Provider' }, { label: 'How often' },
              { label: 'Due day', num: true }, { label: 'Typical', num: true }, { label: 'Per month', num: true },
              { label: 'Status' }, { label: '', actions: true }],
            templates.map(function (t) {
              return el('tr', {}, [
                el('td', { text: t.name }),
                el('td', { class: 'muted', text: t.category }),
                el('td', { class: 'muted', text: t.provider || '—' }),
                el('td', { class: 'muted', text: t.frequency || 'Monthly' }),
                el('td', { class: 'num', text: t.dueDay || 1 }),
                el('td', { class: 'num', text: money(t.expected) }),
                el('td', { class: 'num', title: 'Spread across the year', text: money(S.monthlyEquivalent(t)) }),
                el('td', {}, [el('span', { class: 'status ' + (t.active ? 'paid' : ''), text: t.active ? 'Active' : 'Paused' })]),
                rowActions(
                  function () { openEditor('Edit recurring bill', FIELDS.template, t, function (d) { S.upsert('billTemplates', d); }); },
                  function () { if (confirmDelete('recurring bill')) { S.remove('billTemplates', t.id); render(); } }
                )
              ]);
            })
          ) : null,
          el('div', { class: 'disclosure-body' }, [
            (function () {
              var form = buildForm(FIELDS.template, null);
              return el('form', {
                onsubmit: function (e) {
                  e.preventDefault();
                  var data = form.read();
                  if (!data) { toast('Fill in the required fields'); return; }
                  data.anchor = view.period;
                  S.upsert('billTemplates', data);
                  render();
                  toast('Recurring bill saved');
                }
              }, [
                form.node,
                el('div', { class: 'btn-row', style: 'margin-top:16px' }, [
                  el('button', { class: 'primary', type: 'submit', text: 'Save recurring bill' })
                ])
              ]);
            }())
          ])
        ]) : null
      ])
    ]);
  }

  /* -------------------------------------------------------------- purchases */

  function renderPurchases() {
    var period = view.period;
    var records = S.sortByDateDesc(S.purchasesIn(period), 'date');
    var total = S.sum(records, function (r) { return r.amount; });

    return el('div', { class: 'stack' }, [
      addSection('add-purchase', 'Purchases', 'Add purchase', FIELDS.purchase, function (data) {
        S.upsert('purchases', data);
        toast('Purchase added');
      }, !records.length),

      el('section', { class: 'sheet' }, [
        el('div', { class: 'sheet-head' }, [
          el('h2', { text: S.periodLabel(period) }),
          el('span', { class: 'muted spacer', text: S.plural(records.length, 'item') }),
          el('span', { class: 'num', text: money(total) })
        ]),
        el('div', { class: 'sheet-body flush' }, [table(
          [{ label: 'Date' }, { label: 'Item' }, { label: 'Category' }, { label: 'Amount', num: true },
            { label: 'Paid with' }, { label: 'Notes' }, { label: '', actions: true }],
          records.length ? records.map(function (r) {
            return el('tr', {}, [
              el('td', { class: 'num', text: r.date }),
              el('td', { text: r.item }),
              el('td', { class: 'muted', text: r.category }),
              el('td', { class: 'num', text: money(r.amount) }),
              el('td', { class: 'muted', text: r.method || '—' }),
              el('td', { class: 'truncate muted', title: r.notes || '', text: r.notes || '' }),
              rowActions(
                function () { openEditor('Edit purchase', FIELDS.purchase, r, function (d) { S.upsert('purchases', d); }); },
                function () { if (confirmDelete('purchase')) { S.remove('purchases', r.id); render(); } }
              )
            ]);
          }) : [emptyRow(7, 'Nothing bought in ' + S.periodLabel(period), 'Groceries, fuel, clothes — anything that is not a recurring bill.')]
        )])
      ])
    ]);
  }

  /* ---------------------------------------------------------------- savings */

  function renderSavings() {
    var period = view.period;
    var accounts = S.state.accounts;
    var txs = S.sortByDateDesc(S.savingsTxIn(period), 'date');

    var moveSection = null;
    if (accounts.length) {
      moveSection = addSection('add-saving', 'Movements', 'Record movement', savingsFields(), function (data) {
        S.upsert('savingsTx', data);
        toast(data.direction === 'out' ? 'Withdrawal recorded' : 'Deposit recorded');
      }, !txs.length);
      relabelSavingsForm(moveSection);
    }

    return el('div', { class: 'stack' }, [
      el('section', { class: 'sheet' }, [
        el('div', { class: 'sheet-head' }, [
          el('h2', { text: 'Accounts & pots' }),
          el('span', { class: 'muted spacer num', text: money(S.totalSavings()) }),
          el('button', {
            class: 'primary', text: 'Add account',
            onclick: function () {
              openEditor('Add savings account', FIELDS.account,
                { id: null, name: '', type: 'Savings', opening: 0, target: 0, notes: '' },
                function (d) { d.id = null; S.upsert('accounts', d); });
            }
          })
        ]),
        el('div', { class: 'sheet-body' }, [
          accounts.length
            ? el('div', { class: 'accounts' }, accounts.map(function (a) {
              var balance = S.accountBalance(a.id);
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
                        if (root.confirm('Delete "' + a.name + '" and all of its movements? This cannot be undone.')) {
                          S.remove('accounts', a.id); render();
                        }
                      }
                    })
                  ])
                ]),
                el('div', { class: 'account-balance', text: money(balance) }),
                a.target ? el('div', { class: 'progress' }, [
                  el('div', { style: 'width:' + Math.min(100, Math.max(0, (balance / a.target) * 100)) + '%' })
                ]) : null,
                el('div', { class: 'muted', text: a.target ? Math.round((balance / a.target) * 100) + '% of ' + money(a.target) + ' target' : 'No target set' })
              ]);
            }))
            : el('div', { class: 'empty' }, [
              el('strong', { text: 'No savings accounts yet' }),
              'Add an emergency fund, a holiday pot, or anywhere you put money aside.'
            ])
        ])
      ]),

      moveSection,

      el('section', { class: 'sheet' }, [
        el('div', { class: 'sheet-head' }, [
          el('h2', { text: S.periodLabel(period) }),
          el('span', { class: 'muted spacer', text: S.plural(txs.length, 'movement') })
        ]),
        el('div', { class: 'sheet-body flush' }, [table(
          [{ label: 'Date' }, { label: 'Account' }, { label: 'Direction' }, { label: 'Amount', num: true },
            { label: 'Notes' }, { label: '', actions: true }],
          txs.length ? txs.map(function (t) {
            var account = S.byId('accounts', t.accountId);
            var out = t.direction === 'out';
            return el('tr', {}, [
              el('td', { class: 'num', text: t.date }),
              el('td', { text: account ? account.name : '(deleted)' }),
              el('td', {}, [el('span', { class: 'status ' + (out ? 'overdue' : 'paid'), text: out ? 'Withdrawal' : 'Deposit' })]),
              el('td', { class: 'num', text: (out ? '−' : '+') + money(t.amount) }),
              el('td', { class: 'truncate muted', title: t.notes || '', text: t.notes || '' }),
              rowActions(
                function () {
                  openEditor('Edit movement', savingsFields(), t,
                    function (d) { S.upsert('savingsTx', d); },
                    function (dialog) { relabelSavingsForm(dialog); });
                },
                function () { if (confirmDelete('movement')) { S.remove('savingsTx', t.id); render(); } }
              )
            ]);
          }) : [emptyRow(6, 'No movements in ' + S.periodLabel(period),
            accounts.length ? 'Record what you put aside or took out.' : 'Add an account first.')]
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
            settingRow('Savings goal', goal, '% of income you aim to save')
          ]),
          el('div', { class: 'btn-row', style: 'margin-top:16px' }, [
            el('button', {
              class: 'primary', text: 'Save settings',
              onclick: function () {
                settings.currencySymbol = symbol.value || '';
                settings.currencyCode = code.value || '';
                settings.locale = locale.value || 'en-US';
                settings.savingsGoalRate = Number(goal.value) || 0;
                S.save();
                render();
                toast('Settings saved');
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
    { id: 'savings', label: 'Savings', render: renderSavings },
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
          el('b', { text: 'Income Tracker' })
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

  function render() {
    var app = doc.getElementById('app');
    var scroll = root.scrollY;
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
    root.scrollTo(0, scroll);
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
      view.booting = false;
      if (result.migrated) {
        S.save();
        render();
        toast('Moved your existing records into the database');
        return;
      }
      render();
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
