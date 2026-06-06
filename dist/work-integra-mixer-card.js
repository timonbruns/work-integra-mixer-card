/**
 * Work Pro Integra – Mixer Card
 * Eine Lovelace-Custom-Card im Stil eines Audio-Mischpults:
 * pro Kanal ein Mute-Button, ein vertikaler Fader (dB) und optional ein Pegelbalken.
 *
 * Konfiguration (YAML):
 *   type: custom:work-integra-mixer-card
 *   title: Integra
 *   height: 300            # optional, Höhe der Fader-Bahn in px (Default 300)
 *   channels:
 *     - name: IN8                          # optional, sonst friendly_name
 *       gain: number.dein_fader_entity     # Pflicht (der Fader)
 *       mute: switch.dein_mute_entity       # optional
 *       meter: sensor.dein_pegel_entity     # optional (falls Pegel-Sensoren vorhanden)
 */

const DB_TICKS = [12, 6, 3, 0, -3, -6, -12, -24, -36, -48, -60, -72];

class WorkIntegraMixerCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._built = false;
    this._strips = [];
    this._drag = null; // {channelIndex, value}
  }

  setConfig(config) {
    if (!config || !Array.isArray(config.channels) || config.channels.length === 0) {
      throw new Error("Bitte mindestens einen Kanal unter 'channels' angeben.");
    }
    for (const ch of config.channels) {
      if (!ch.gain) throw new Error("Jeder Kanal braucht eine 'gain'-Entity (der Fader).");
    }
    this._config = {
      title: config.title || "",
      height: Number(config.height) || 300,
      channels: config.channels,
    };
    this._built = false;
    if (this._hass) this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._built) this._render();
    else this._update();
  }

  getCardSize() {
    return Math.ceil((this._config?.height || 300) / 50) + 2;
  }

  // --- Hilfen ---------------------------------------------------------

  _bounds(stateObj) {
    const a = stateObj?.attributes || {};
    const min = a.min !== undefined ? Number(a.min) : -72;
    const max = a.max !== undefined ? Number(a.max) : 12;
    const step = a.step !== undefined ? Number(a.step) : 0.5;
    return { min, max, step };
  }

  _clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
  }

  _round(v, step) {
    return Math.round(v / step) * step;
  }

  // Position (0 oben .. 1 unten innerhalb der Bahn) -> dB
  _fracToValue(frac, b) {
    const value = b.min + (1 - frac) * (b.max - b.min);
    return this._clamp(this._round(value, b.step), b.min, b.max);
  }

  // dB -> Anteil von oben (0..1)
  _valueToFrac(value, b) {
    return 1 - (value - b.min) / (b.max - b.min);
  }

  // --- Rendering ------------------------------------------------------

  _render() {
    if (!this._hass || !this._config) return;
    const c = this._config;

    this.shadowRoot.innerHTML = `
      <style>${WorkIntegraMixerCard.styles(c.height)}</style>
      <ha-card>
        ${c.title ? `<div class="title">${c.title}</div>` : ""}
        <div class="rack"></div>
      </ha-card>
    `;
    const rack = this.shadowRoot.querySelector(".rack");
    this._strips = [];

    c.channels.forEach((ch, i) => {
      const strip = document.createElement("div");
      strip.className = "strip";
      strip.innerHTML = `
        <div class="name"></div>
        <button class="mute" type="button">Mute</button>
        <div class="fader">
          <div class="scale"></div>
          <div class="meter"><div class="meter-fill"></div></div>
          <div class="track">
            <div class="track-line"></div>
            <div class="cap"><span class="cap-line"></span></div>
          </div>
        </div>
        <div class="readout"></div>
      `;
      rack.appendChild(strip);

      const refs = {
        cfg: ch,
        el: strip,
        name: strip.querySelector(".name"),
        mute: strip.querySelector(".mute"),
        track: strip.querySelector(".track"),
        cap: strip.querySelector(".cap"),
        meterFill: strip.querySelector(".meter-fill"),
        readout: strip.querySelector(".readout"),
        scale: strip.querySelector(".scale"),
      };

      // dB-Skala beschriften
      refs.scale.innerHTML = DB_TICKS.map(
        (t) => `<span style="top:${(this._tickTop(t)).toFixed(2)}%">${t > 0 ? "+" + t : t}</span>`
      ).join("");

      // Mute
      refs.mute.addEventListener("click", () => this._toggleMute(ch));

      // Fader: ziehen + klicken
      refs.track.addEventListener("pointerdown", (e) => this._onDown(e, i));

      this._strips.push(refs);
    });

    this._built = true;
    this._update();
  }

  _tickTop(db) {
    // Position der Skalenbeschriftung passend zum (linearen) Fadebereich.
    // Nutzt feste -72..12-Spanne für die Skala; Fader selbst nutzt Entity-Grenzen.
    const min = -72, max = 12;
    return (1 - (db - min) / (max - min)) * 100;
  }

  _update() {
    if (!this._hass || !this._built) return;
    for (let i = 0; i < this._strips.length; i++) {
      const s = this._strips[i];
      const gainObj = this._hass.states[s.cfg.gain];
      const b = this._bounds(gainObj);

      // Name
      const label =
        s.cfg.name ||
        (gainObj && gainObj.attributes.friendly_name) ||
        s.cfg.gain;
      s.name.textContent = label;
      s.name.title = label;

      // Fader-Position (während des Ziehens nicht überschreiben)
      let value;
      if (this._drag && this._drag.index === i) {
        value = this._drag.value;
      } else {
        value = gainObj ? Number(gainObj.state) : b.min;
      }
      if (!Number.isFinite(value)) value = b.min;
      const frac = this._clamp(this._valueToFrac(value, b), 0, 1);
      s.cap.style.top = `${(frac * 100).toFixed(2)}%`;
      s.readout.textContent = `${value > 0 ? "+" : ""}${value.toFixed(1)} dB`;

      // Mute
      if (s.cfg.mute) {
        const muteObj = this._hass.states[s.cfg.mute];
        const on = muteObj && muteObj.state === "on";
        s.mute.classList.toggle("active", !!on);
        s.mute.style.display = "";
      } else {
        s.mute.style.visibility = "hidden";
      }

      // Pegel (optional)
      if (s.cfg.meter && this._hass.states[s.cfg.meter]) {
        const lvl = Number(this._hass.states[s.cfg.meter].state);
        const mFrac = this._clamp(1 - (lvl - b.min) / (b.max - b.min), 0, 1);
        s.meterFill.style.height = `${((1 - mFrac) * 100).toFixed(1)}%`;
        s.meterFill.parentElement.style.visibility = "";
      } else {
        s.meterFill.parentElement.style.visibility = "hidden";
      }
    }
  }

  // --- Interaktion ----------------------------------------------------

  _toggleMute(ch) {
    if (!ch.mute) return;
    this._hass.callService("switch", "toggle", { entity_id: ch.mute });
  }

  _onDown(e, index) {
    e.preventDefault();
    const s = this._strips[index];
    const b = this._bounds(this._hass.states[s.cfg.gain]);
    this._drag = { index, b, value: 0 };
    s.el.classList.add("dragging");

    const move = (ev) => {
      const rect = s.track.getBoundingClientRect();
      const frac = this._clamp((ev.clientY - rect.top) / rect.height, 0, 1);
      this._drag.value = this._fracToValue(frac, b);
      this._update();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const value = this._drag.value;
      s.el.classList.remove("dragging");
      this._drag = null;
      // Befehl erst beim Loslassen senden -> genau ein set pro Regelvorgang
      this._hass.callService("number", "set_value", {
        entity_id: s.cfg.gain,
        value,
      });
    };

    // Erstklick positioniert den Fader sofort
    move(e);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  static styles(height) {
    return `
      ha-card { padding: 12px; background: transparent; border: none; box-shadow: none; color: #d7d7da; }
      .title { font-size: 16px; font-weight: 600; margin: 2px 4px 10px; }
      .rack { display: inline-flex; gap: 2px; overflow-x: auto; padding-bottom: 4px; }
      .strip {
        flex: 0 0 78px; width: 78px;
        background: #262629; border: 1px solid #38383c; border-radius: 6px;
        padding: 8px 6px; display: flex; flex-direction: column; align-items: center;
      }
      .name {
        width: 100%; text-align: center; font-size: 12px; font-weight: 600;
        color: #e6e6e9; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        margin-bottom: 8px;
      }
      .mute {
        width: 100%; font: inherit; font-size: 11px; padding: 4px 0; margin-bottom: 10px;
        color: #cfcfd3; background: #2f2f33; border: 1px solid #4a4a50; border-radius: 4px;
        cursor: pointer; transition: all .12s ease;
      }
      .mute:hover { background: #3a3a3f; }
      .mute.active {
        color: #fff; background: #c0392b; border-color: #e25647;
        box-shadow: 0 0 8px rgba(224,86,71,.5);
      }
      .fader {
        position: relative; height: ${height}px; width: 100%;
        display: flex; justify-content: center;
      }
      .scale {
        position: absolute; right: 4px; top: 0; height: 100%; width: 22px;
        font-size: 9px; color: #8a8a90;
      }
      .scale span {
        position: absolute; right: 0; transform: translateY(-50%);
        line-height: 1; white-space: nowrap;
      }
      .scale span::before {
        content: ""; position: absolute; right: 100%; top: 50%; margin-right: 2px;
        width: 4px; height: 1px; background: #5a5a60;
      }
      .meter {
        position: absolute; left: 8px; top: 0; height: 100%; width: 6px;
        background: #141416; border-radius: 3px; overflow: hidden;
        display: flex; align-items: flex-end;
      }
      .meter-fill {
        width: 100%; height: 0%;
        background: linear-gradient(to top, #16a34a 0%, #22d3ee 70%, #fde047 100%);
        transition: height .15s linear;
      }
      .track {
        position: absolute; left: 50%; transform: translateX(-50%);
        top: 0; height: 100%; width: 30px; cursor: pointer; touch-action: none;
      }
      .track-line {
        position: absolute; left: 50%; transform: translateX(-50%);
        top: 6px; bottom: 6px; width: 4px; border-radius: 2px;
        background: #0e0e10; box-shadow: inset 0 0 2px #000;
      }
      .cap {
        position: absolute; left: 50%; width: 30px; height: 18px;
        transform: translate(-50%, -50%); border-radius: 4px;
        background: linear-gradient(#5a5a60, #303034);
        border: 1px solid #6b6b72; box-shadow: 0 1px 3px rgba(0,0,0,.6);
      }
      .cap-line {
        position: absolute; left: 3px; right: 3px; top: 50%; height: 2px;
        transform: translateY(-50%); background: #22d3ee; border-radius: 1px;
        box-shadow: 0 0 4px rgba(34,211,238,.8);
      }
      .strip.dragging .cap { border-color: #22d3ee; }
      .readout {
        margin-top: 8px; font-size: 11px; color: #9a9aa0;
        font-variant-numeric: tabular-nums;
      }
    `;
  }
}

customElements.define("work-integra-mixer-card", WorkIntegraMixerCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "work-integra-mixer-card",
  name: "Work Pro Integra Mixer",
  description: "Mischpult-Ansicht mit vertikalen Fadern und Mute für die Integra.",
});

console.info("%c WORK-INTEGRA-MIXER-CARD %c geladen ", "background:#22d3ee;color:#000;font-weight:700", "");
