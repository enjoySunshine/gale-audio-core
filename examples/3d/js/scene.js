/*!
 *  Howler.js 3D Sound Demo - Sample-locked storm scene engine.
 *
 *  All four scene voices (rain, thunder, lightning, speaker/music) share one
 *  integer scene sample position counted at the AudioContext sample rate.
 *  The decoded AudioBuffer is shared across every voice (one decode, no
 *  per-voice copies) and three gain buses (rain / storm / speaker) sit between
 *  the voices and Howler.masterGain, so Howler.volume() still masters
 *  everything on this page.
 */

'use strict';

var StormScene = function(howl, sprites, opts) {
  this.howl = howl;
  this.sprites = sprites;
  this.options = opts || {};
  this.leadSec = (typeof this.options.lead === 'number') ? this.options.lead : 0.25;

  // Scene transport state.
  this.running = false;
  this.paused = false;
  this.startedAt = 0;        // ctx.currentTime of scene sample 0.
  this.anchorSample = 0;     // Integer scene sample at anchorTime.
  this.anchorTime = 0;       // ctx.currentTime the anchor was taken at.
  this.sceneRate = 1;        // Rate of the shared scene clock.
  this.sampleRate = 0;

  // Three mix buses: rain / storm (thunder+lightning) / speaker.
  this.buses = {};

  // Live voice registry and pending speaker placements.
  this.voices = [];
  this.speakers = [];

  // Cached loudness values for the HUD (0 while a voice is not playing).
  this.loudness = {rain: 0, thunder: 0, lightning: 0, speaker: 0};

  this._boundResume = this._onCtxResume.bind(this);
  this._ctx = Howler.ctx;
  this._ctx.addEventListener('statechange', this._boundResume);

  // The Howl owns the only decode of the sprite file; we reuse that buffer.
  var self = this;
  if (howl.state() === 'loaded') {
    this._onLoad();
  } else {
    howl.once('load', function() {
      self._onLoad();
    });
  }
};

StormScene.prototype = {
  /**
   * Make sure the statechange listener follows the context. Howler can
   * replace the AudioContext (e.g. its mobile sample-rate unload path).
   */
  _bindContext: function() {
    if (this._ctx === Howler.ctx) {
      return;
    }

    if (this._ctx) {
      this._ctx.removeEventListener('statechange', this._boundResume);
    }
    this._ctx = Howler.ctx;
    this._ctx.addEventListener('statechange', this._boundResume);
  },

  /**
   * Pull the shared decoded buffer out of the Howl (it created and decoded it;
   * all of our BufferSourceNodes point at this same buffer). The throwaway
   * source Howler builds here is disconnected immediately so nothing is
   * left connected through the Howl's own (muted) gain node.
   */
  _getBuffer: function() {
    var sound = this.howl._sounds && this.howl._sounds[0];
    if (sound) {
      this.howl._refreshBuffer(sound);
      if (sound._node && sound._node.bufferSource) {
        var buffer = sound._node.bufferSource.buffer;
        sound._node.bufferSource.onended = null;
        try { sound._node.bufferSource.disconnect(0); } catch (e) {}
        sound._node.bufferSource = null;
        return buffer;
      }
    }
    return null;
  },

  /**
   * Fired once the sprite file has finished decoding. The scene sample stays
   * at 0 until this point; decode time is never counted against the lead.
   */
  _onLoad: function() {
    this._bindContext();
    this.buffer = this._getBuffer();
    if (!this.buffer) {
      // The context may have been replaced (e.g. mobile unload); retry.
      var self = this;
      setTimeout(function() {
        self._onLoad();
      }, 50);
      return;
    }

    this.sampleRate = Howler.ctx.sampleRate;
    this._beginWhenReady();
  },

  /**
   * Begin playback at ctx.currentTime + lead, measured purely against the
   * audio clock. If the context is suspended (no user gesture yet) the lead
   * does not start ticking until it is actually running.
   */
  _beginWhenReady: function() {
    if (this.running || Howler.ctx.state !== 'running') {
      return;
    }

    this._buildBuses();

    // Scene sample 0 starts one lead interval in the audio-clock future.
    this.startedAt = Howler.ctx.currentTime + this.leadSec;
    this.anchorSample = 0;
    this.anchorTime = this.startedAt;
    this.running = true;

    // Opening: rain and every queued speaker start together, at sample 0.
    this._startRain();
    for (var i = 0; i < this.speakers.length; i++) {
      var sp = this.speakers[i];
      this._startSpeaker(sp.x, sp.y, sp.z, this.startedAt);
    }

    if (this.options.onstart) {
      this.options.onstart();
    }
  },

  /**
   * Context resumed (user gesture, tab refocus, etc.). Either start the scene
   * for the first time, or restart paused voices at their exact samples.
   */
  _onCtxResume: function() {
    if (Howler.ctx.state !== 'running') {
      return;
    }

    if (!this.running) {
      this._beginWhenReady();
      return;
    }

    if (this.paused) {
      this._resumeVoices();
    }
  },

  /**
   * Create the three mix buses, all feeding Howler's master gain so the global
   * Howler volume continues to scale every voice on this page.
   */
  _buildBuses: function() {
    var ctx = Howler.ctx;
    var names = ['rain', 'storm', 'speaker'];
    for (var i = 0; i < names.length; i++) {
      var gain = ctx.createGain();
      gain.gain.setValueAtTime(1, ctx.currentTime);
      gain.connect(Howler.masterGain);
      this.buses[names[i]] = gain;
    }
  },

  /**
   * Current scene sample position as an integer, counted at the context's
   * sample rate. It only advances while the scene is running and unpaused, so
   * waiting on wall-clock time (loading, pausing, suspended context) is never
   * "played through".
   */
  sample: function() {
    if (!this.running || this.paused) {
      return this.anchorSample;
    }

    var elapsed = Math.max(0, Howler.ctx.currentTime - this.anchorTime);
    return this.anchorSample + Math.round(elapsed * this.sceneRate * this.sampleRate);
  },

  /**
   * Create the gain node (and optional panner) chain for a new voice.
   */
  _addVoice: function(busName, spatial, pannerAttr) {
    var ctx = Howler.ctx;
    var voice = {
      active: true,
      loop: false,
      bus: this.buses[busName],
      gain: ctx.createGain(),
      panner: null,
      source: null,
      rateFactor: 1,
      volume: 1,
      // Sprite window (seconds in the shared buffer).
      start: 0,
      stop: 0,
      // Scene sample this voice began at, and the buffer offset it began at.
      originSample: 0,
      originOffset: 0
    };

    if (spatial) {
      voice.panner = ctx.createPanner();
      var pa = pannerAttr || {};
      voice.panner.panningModel = pa.panningModel || 'HRTF';
      voice.panner.distanceModel = pa.distanceModel || 'inverse';
      voice.panner.refDistance = typeof pa.refDistance === 'number' ? pa.refDistance : 1;
      voice.panner.rolloffFactor = typeof pa.rolloffFactor === 'number' ? pa.rolloffFactor : 1;
      voice.panner.maxDistance = typeof pa.maxDistance === 'number' ? pa.maxDistance : 10000;
      voice.panner.coneInnerAngle = typeof pa.coneInnerAngle === 'number' ? pa.coneInnerAngle : 360;
      voice.panner.coneOuterAngle = typeof pa.coneOuterAngle === 'number' ? pa.coneOuterAngle : 360;
      voice.panner.coneOuterGain = typeof pa.coneOuterGain === 'number' ? pa.coneOuterGain : 0;
      if (voice._pos) {
        this._setPannerPos(voice.panner, voice._pos);
      }
      voice.gain.connect(voice.panner);
      voice.panner.connect(voice.bus);
    } else {
      voice.gain.connect(voice.bus);
    }

    this.voices.push(voice);
    return voice;
  },

  /**
   * Set a panner's position using the modern AudioParam API when available.
   */
  _setPannerPos: function(panner, pos) {
    if (typeof panner.positionX !== 'undefined') {
      panner.positionX.setValueAtTime(pos[0], Howler.ctx.currentTime);
      panner.positionY.setValueAtTime(pos[1], Howler.ctx.currentTime);
      panner.positionZ.setValueAtTime(pos[2], Howler.ctx.currentTime);
    } else {
      panner.setPosition(pos[0], pos[1], pos[2]);
    }
  },

  /**
   * Buffer offset (seconds) this voice should be playing at the current scene
   * sample. Looping wraps inside the sprite window; one-shots simply stop.
   */
  _voiceOffset: function(voice) {
    var span = voice.stop - voice.start;
    var deltaSamples = this.sample() - voice.originSample;
    var deltaSec = deltaSamples / this.sampleRate;
    var rel = voice.originOffset + deltaSec * voice.rateFactor;

    if (voice.loop) {
      rel = rel % span;
      if (rel < 0) {
        rel += span;
      }
    }

    return voice.start + rel;
  },

  /**
   * (Re)create the BufferSourceNode for a voice and start it, at a specific
   * ctx time (defaults to now). The scene sample is never moved by this call;
   * the source simply joins the clock at whatever sample the scene is on.
   */
  _launch: function(voice, when, explicitOffset) {
    var ctx = Howler.ctx;
    var source = ctx.createBufferSource();
    source.buffer = this.buffer;
    source.playbackRate.setValueAtTime(voice.rateFactor * this.sceneRate, ctx.currentTime);

    if (voice.loop) {
      source.loop = true;
      source.loopStart = voice.start;
      source.loopEnd = voice.stop;
    }

    source.connect(voice.gain);
    voice.source = source;

    var self = this;
    voice._ended = false;
    source.onended = function() {
      // Ignore the event we cause ourselves on stop/pause.
      if (voice._ended || !voice.active) {
        return;
      }
      voice._ended = true;
      voice.active = false;
      self._disposeVoice(voice);
    };

    var offset = (typeof explicitOffset === 'number') ? explicitOffset : this._voiceOffset(voice);
    var duration = voice.loop ? undefined : Math.max(0, voice.stop - offset);
    when = (typeof when === 'number') ? when : ctx.currentTime;

    if (typeof source.start === 'undefined') {
      source.noteGrainOn(when, offset, duration || 86400);
    } else {
      source.start(when, offset, duration);
    }
  },

  /**
   * Remove a finished voice and its nodes from the registry.
   */
  _disposeVoice: function(voice) {
    var idx = this.voices.indexOf(voice);
    if (idx >= 0) {
      this.voices.splice(idx, 1);
    }
    if (voice.source) {
      voice.source.onended = null;
      try { voice.source.disconnect(0); } catch (e) {}
      voice.source = null;
    }
  },

  /**
   * Start the looping rain voice. Rain has no spatial position, per the scene.
   */
  _startRain: function() {
    var sprite = this.sprites.rain;
    var voice = this._addVoice('rain', false);
    voice.loop = true;
    voice.start = sprite[0] / 1000;
    voice.stop = (sprite[0] + sprite[1]) / 1000;
    voice.volume = 0.2;
    voice.originSample = 0;
    voice.originOffset = 0;
    voice.gain.gain.setValueAtTime(voice.volume, Howler.ctx.currentTime);
    this.rainVoice = voice;
    this._launch(voice, this.startedAt);
  },

  /**
   * Register a speaker placement. Speakers placed before the scene starts are
   * queued and all start together with the rain at scene sample 0.
   */
  addSpeaker: function(x, y, z) {
    var pos = [x, y, typeof z === 'number' ? z : -0.5];
    this.speakers.push({x: x, y: y, z: pos[2]});

    if (this.running) {
      this._startSpeaker(pos[0], pos[1], pos[2]);
    }
  },

  /**
   * Start one looping speaker voice. All speaker loops share the same scene
   * sample, so every speaker stays phase-locked to the same long loop.
   */
  _startSpeaker: function(x, y, z, when) {
    var sprite = this.sprites.music;
    var voice = this._addVoice('speaker', true, {
      panningModel: 'HRTF',
      distanceModel: 'exponential',
      refDistance: 0.8,
      rolloffFactor: 2.5
    });
    voice.loop = true;
    voice.start = sprite[0] / 1000;
    voice.stop = (sprite[0] + sprite[1]) / 1000;
    voice.volume = 1;
    voice.originSample = this.sample();
    voice.originOffset = 0;
    voice._pos = [x, y, z];
    this._setPannerPos(voice.panner, voice._pos);
    voice.gain.gain.setValueAtTime(voice.volume, Howler.ctx.currentTime);

    // Queued speakers launch together with the rain at scene sample 0;
    // speakers added later join at "now".
    if (typeof when !== 'number') {
      when = this.running ? Howler.ctx.currentTime : this.startedAt;
    }
    this._launch(voice, when);
  },

  /**
   * Spawn a thunderclap. The trigger lands on the current scene sample; no
   * sound is emitted before the sample moves.
   * @param {Array} pos Optional [x, y, z] source position.
   * @return {Object} The voice handle.
   */
  spawnThunder: function(pos) {
    if (!this.running || this.paused) {
      return null;
    }

    var sprite = this.sprites.thunder;
    var voice = this._addVoice('storm', true);
    voice.loop = false;
    voice.start = sprite[0] / 1000;
    voice.stop = (sprite[0] + sprite[1]) / 1000;
    voice.volume = 1;
    voice.originSample = this.sample();
    voice.originOffset = 0;
    if (pos) {
      voice._pos = [pos[0], pos[1], typeof pos[2] === 'number' ? pos[2] : -0.5];
      this._setPannerPos(voice.panner, voice._pos);
    }
    voice.gain.gain.setValueAtTime(voice.volume, Howler.ctx.currentTime);
    this._launch(voice);
    return voice;
  },

  /**
   * Spawn a lightning crack. Its random rate/pitch only affects this one
   * source; the shared scene sample is untouched.
   * @param {Array} pos  Optional [x, y, z] source position.
   * @param {Number} rate Rate factor for this voice alone.
   * @return {Object} The voice handle.
   */
  spawnLightning: function(pos, rate) {
    if (!this.running || this.paused) {
      return null;
    }

    var sprite = this.sprites.lightning;
    var voice = this._addVoice('storm', true);
    voice.loop = false;
    voice.start = sprite[0] / 1000;
    voice.stop = (sprite[0] + sprite[1]) / 1000;
    voice.volume = 1;
    voice.rateFactor = (typeof rate === 'number') ? rate : 1;
    voice.originSample = this.sample();
    voice.originOffset = 0;
    if (pos) {
      voice._pos = [pos[0], pos[1], typeof pos[2] === 'number' ? pos[2] : -0.5];
      this._setPannerPos(voice.panner, voice._pos);
    }
    voice.gain.gain.setValueAtTime(voice.volume, Howler.ctx.currentTime);
    this._launch(voice);
    return voice;
  },

  /**
   * Move a spatial voice. Only the panner changes; the scene sample and every
   * other voice stay exactly where they were.
   */
  setVoicePos: function(voice, x, y, z) {
    if (!voice || !voice.panner) {
      return;
    }
    voice._pos = [x, y, typeof z === 'number' ? z : -0.5];
    this._setPannerPos(voice.panner, voice._pos);
  },

  /**
   * Pause the whole scene. Each voice stops at its current sample and the
   * scene clock freezes; wall-clock time spent paused is never played back.
   */
  pause: function() {
    if (!this.running || this.paused) {
      return;
    }

    // Freeze the shared clock at its current integer sample.
    this.anchorSample = this.sample();
    this.anchorTime = Howler.ctx.currentTime;
    this.paused = true;

    for (var i = 0; i < this.voices.length; i++) {
      var voice = this.voices[i];
      if (voice.source) {
        voice._ended = true;
        voice.source.onended = null;
        try { voice.source.stop(0); } catch (e) {}
        try { voice.source.disconnect(0); } catch (e) {}
        voice.source = null;
      }
    }
  },

  /**
   * Resume from the exact sample the scene was paused at, even after the
   * context has been suspended for longer than 30 seconds.
   */
  resume: function() {
    if (!this.running || !this.paused) {
      return;
    }

    var ctx = Howler.ctx;
    if (ctx.state !== 'running') {
      if (typeof ctx.resume === 'function') {
        ctx.resume();
      }
      // _onCtxResume restarts the voices once the context is actually running.
      return;
    }

    this._resumeVoices();
  },

  /**
   * Restart every still-alive voice at its paused sample. One-shots whose
   * sprite window has already elapsed are dropped instead.
   */
  _resumeVoices: function() {
    if (!this.paused) {
      return;
    }

    // Re-anchor: no scene time passed while paused.
    this.anchorTime = Howler.ctx.currentTime;
    this.paused = false;

    for (var i = 0; i < this.voices.length; i++) {
      var voice = this.voices[i];
      var offset = this._voiceOffset(voice);

      if (!voice.loop && offset >= voice.stop) {
        voice.active = false;
        this._disposeVoice(voice);
        continue;
      }

      // Guard against a sub-sample float overshoot right at the sprite end.
      if (!voice.loop && offset > voice.stop - 1e-7) {
        offset = voice.stop - 1e-7;
      }

      voice._ended = false;
      voice.active = true;
      this._launch(voice, undefined, offset);
    }

    // _disposeVoice removed the finished one-shots from the registry.
    this.voices = this.voices.filter(function(v) {
      return v.active;
    });
  },

  /**
   * Change the scene rate. Rain and speaker loops and the shared scene sample
   * advance at the new rate; an individual lightning voice keeps its own
   * random rate factor on top of the scene rate.
   */
  setSceneRate: function(rate) {
    if (!this.running || rate <= 0) {
      return;
    }

    // Lock the clock at the current sample before changing rates.
    this.anchorSample = this.sample();
    this.anchorTime = Howler.ctx.currentTime;
    this.sceneRate = rate;

    for (var i = 0; i < this.voices.length; i++) {
      var voice = this.voices[i];
      if (voice.source) {
        voice.source.playbackRate.setValueAtTime(voice.rateFactor * rate, Howler.ctx.currentTime);
      }
    }
  },

  /**
   * Get/set the gain of one mix bus ('rain', 'storm' or 'speaker'). Setting a
   * bus to 0 silences only that bus; the scene sample and other buses keep
   * moving unchanged.
   */
  busVolume: function(name, vol) {
    var bus = this.buses[name];
    if (!bus) {
      return 0;
    }

    if (typeof vol === 'number') {
      vol = Math.min(1, Math.max(0, vol));
      bus.gain.setValueAtTime(vol, Howler.ctx.currentTime);
      return vol;
    }

    return bus.gain.value;
  },

  /**
   * Distance attenuation gain for a panner, matching the Web Audio distance
   * models used by the spatial plugin's PannerNode.
   */
  _distanceGain: function(voice) {
    if (!voice.panner || !voice._pos) {
      return 1;
    }

    var listener = Howler._pos || [0, 0, 0];
    var dx = voice._pos[0] - listener[0];
    var dy = voice._pos[1] - listener[1];
    var dz = voice._pos[2] - listener[2];
    var dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

    var p = voice.panner;
    if (p.distanceModel === 'linear') {
      var d = Math.min(dist, p.maxDistance);
      return 1 - p.rolloffFactor * (d - p.refDistance) / (p.maxDistance - p.refDistance);
    }

    if (p.distanceModel === 'exponential') {
      // rolloffFactor of 0 would be invalid for the Web Audio formula.
      if (p.rolloffFactor === 0 || dist === 0) {
        return 1;
      }
      // Clamp to a small positive floor before dividing (a plain EPSILON here
      // underflows to 0 once divided by the reference distance).
      var ratio = Math.max(dist, 1e-8) / p.refDistance;
      return Math.pow(ratio, -p.rolloffFactor);
    }

    // inverse (default).
    return p.refDistance / (p.refDistance + p.rolloffFactor * Math.max(0, dist - p.refDistance));
  },

  /**
   * Compute the current loudness of each of the four displayed channels.
   * Loudness = voice gain x distance attenuation x bus gain x Howler master.
   * Rain has no spatial position, so listener movement never changes it.
   */
  updateLoudness: function() {
    var master = Howler.volume();
    var rainBus = this.buses.rain ? this.buses.rain.gain.value : 1;
    var stormBus = this.buses.storm ? this.buses.storm.gain.value : 1;
    var speakerBus = this.buses.speaker ? this.buses.speaker.gain.value : 1;

    var rain = 0;
    var thunder = 0;
    var lightning = 0;
    var speaker = 0;

    for (var i = 0; i < this.voices.length; i++) {
      var voice = this.voices[i];
      if (!voice.active) {
        continue;
      }

      var level = voice.volume * this._distanceGain(voice);
      var sprite = this._voiceSpriteName(voice);

      if (sprite === 'rain') {
        rain = level * rainBus;
      } else if (sprite === 'thunder') {
        // Several claps may overlap; show the loudest currently playing one.
        thunder = Math.max(thunder, level * stormBus);
      } else if (sprite === 'lightning') {
        lightning = Math.max(lightning, level * stormBus);
      } else if (sprite === 'music') {
        speaker = Math.max(speaker, level * speakerBus);
      }
    }

    this.loudness.rain = rain * master;
    this.loudness.thunder = thunder * master;
    this.loudness.lightning = lightning * master;
    this.loudness.speaker = speaker * master;
  },

  /**
   * Identify which sprite window a voice is playing from.
   */
  _voiceSpriteName: function(voice) {
    var names = ['rain', 'thunder', 'lightning', 'music'];
    for (var i = 0; i < names.length; i++) {
      var def = this.sprites[names[i]];
      if (def && voice.start === def[0] / 1000) {
        return names[i];
      }
    }
    return null;
  },

  /**
   * Tear down the scene and all of its audio nodes.
   */
  destroy: function() {
    if (this._ctx) {
      this._ctx.removeEventListener('statechange', this._boundResume);
    }
    for (var i = 0; i < this.voices.length; i++) {
      var voice = this.voices[i];
      if (voice.source) {
        try { voice.source.stop(0); } catch (e) {}
      }
    }
    this.voices = [];
  }
};
