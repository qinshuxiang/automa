(function () {
  'use strict';

  var activePicker = null;

  function accepts(file, rules) {
    var type = file.type.toLowerCase();
    var name = file.name.toLowerCase();
    var extensions = {
      'application/json': ['.json'],
      'text/csv': ['.csv'],
      'text/plain': ['.txt'],
      'application/vnd.ms-excel': ['.xls', '.csv'],
    };
    return !rules.length || rules.some(function (rule) {
      if (rule.charAt(0) === '.') return name.endsWith(rule);
      if (rule.endsWith('/*')) return type.startsWith(rule.slice(0, -1));
      if (type) return type === rule;
      return (extensions[rule] || []).some(function (ext) { return name.endsWith(ext); });
    });
  }

  function pickFiles(accepted, attrs) {
    if (activePicker) activePicker();
    return new Promise(function (resolve, reject) {
      var input = document.createElement('input');
      var rules = (Array.isArray(accepted) ? accepted : String(accepted || '').split(','))
        .map(function (rule) { return rule.trim().toLowerCase(); }).filter(Boolean);
      var settled = false;
      var timer = null;
      input.type = 'file';
      input.accept = rules.join(',');
      Object.keys(attrs || {}).forEach(function (key) { input[key] = attrs[key]; });
      input.style.display = 'none';
      document.body.appendChild(input);

      function finish(error, files) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        window.removeEventListener('focus', returned);
        window.removeEventListener('blur', away);
        document.removeEventListener('visibilitychange', visibility);
        document.removeEventListener('pointerdown', returned, true);
        document.removeEventListener('keydown', returned, true);
        input.onchange = input.oncancel = input.onerror = null;
        input.remove();
        if (activePicker === cancel) activePicker = null;
        if (error) reject(error);
        else resolve(files || []);
      }

      function selected() {
        finish(null, Array.from(input.files || []).filter(function (file) { return accepts(file, rules); }));
      }
      function cancel() { finish(null, []); }
      function away() { clearTimeout(timer); }
      // Chromium 90 does not emit the input cancel event. Wait for focus to return.
      function returned() {
        clearTimeout(timer);
        timer = setTimeout(function () {
          if (!document.hidden && document.hasFocus()) selected();
        }, 300);
      }
      function visibility() { if (document.hidden) away(); else returned(); }

      activePicker = cancel;
      input.onchange = selected;
      input.oncancel = cancel;
      input.onerror = function () { finish(new Error('Unable to open the file picker')); };
      window.addEventListener('focus', returned);
      window.addEventListener('blur', away);
      document.addEventListener('visibilitychange', visibility);
      document.addEventListener('pointerdown', returned, true);
      document.addEventListener('keydown', returned, true);
      try { input.click(); } catch (error) { finish(error); }
    });
  }

  function readBlob(blob, mode, signal) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      var settled = false;
      function finish(error) {
        if (settled) return;
        settled = true;
        if (signal) signal.removeEventListener('abort', cancel);
        reader.onload = reader.onerror = reader.onabort = null;
        if (error) reject(error);
        else resolve(reader.result);
      }
      function cancel() {
        finish(new Error('File reading cancelled'));
        reader.abort();
      }
      reader.onload = function () { finish(); };
      reader.onerror = function () { finish(reader.error || new Error('File reading failed')); };
      reader.onabort = function () { finish(new Error('File reading cancelled')); };
      if (signal) {
        if (signal.aborted) return cancel();
        signal.addEventListener('abort', cancel, { once: true });
      }
      try {
        if (mode === 'text') reader.readAsText(blob);
        else reader.readAsDataURL(blob);
      } catch (error) { finish(error); }
    });
  }

  globalThis.__automaAsyncLifecycle = { pickFiles: pickFiles, readBlob: readBlob };
})();
