(function() {
  var SHADER   = 'color-pop';
  var defaults = { u_saturation: 1.5, u_brightness: 1.05 };

  // Push defaults immediately so the shader has values from frame 1
  ShaderSystem.setUniforms(SHADER, defaults);

  _registerShaderUI(SHADER, function(container) {
    var params = { u_saturation: defaults.u_saturation, u_brightness: defaults.u_brightness };

    function makeSlider(label, key, min, max, step, init) {
      var row = document.createElement('div');
      var lbl = document.createElement('span');
      lbl.style.cssText = 'display:inline-block;width:90px';
      lbl.textContent   = label + ': ' + init.toFixed(2);
      var s = document.createElement('input');
      s.type  = 'range';
      s.min   = min;  s.max = max;  s.step = step;
      s.value = init;
      s.style.cssText = 'width:100px;vertical-align:middle';
      s.addEventListener('input', function() {
        var v = parseFloat(s.value);
        lbl.textContent = label + ': ' + v.toFixed(2);
        params[key] = v;
        ShaderSystem.setUniforms(SHADER, params);
      });
      row.appendChild(lbl);
      row.appendChild(s);
      container.appendChild(row);
    }

    makeSlider('saturation', 'u_saturation', 0, 3,   0.01, params.u_saturation);
    makeSlider('brightness', 'u_brightness', 0, 2,   0.01, params.u_brightness);
  });
})();
