/*!
 *  Howler.js 3D Sound Demo
 *  howlerjs.com
 *
 *  (c) 2013-2020, James Simpson of GoldFire Studios
 *  goldfirestudios.com
 *
 *  MIT License
 */

'use strict';

/**
 * Setup and control all of the game's audio.
 *
 * The Howl below owns the single decode of the sprite file and its decoded
 * AudioBuffer is shared by every voice in StormScene. No scene sound is played
 * through Howler's own Sound pool; the scene drives its own sample-locked
 * Web Audio nodes while the Howl keeps providing the context, master gain and
 * spatial listener.
 */
var Sound = function() {
  // Setup the shared Howl. It defines the same sprite windows as before and
  // remains available as `game.audio.sound` for anything external.
  this.sound = new Howl({
    src: ['./assets/sprite.webm', './assets/sprite.mp3'],
    sprite: {
      lightning: [2000, 4147],
      rain: [8000, 9962, true],
      thunder: [19000, 13858],
      music: [34000, 31994, true]
    },
    volume: 0
  });

  // The scene pauses explicitly; Howler's 30-second auto-suspend must not cut
  // in underneath a paused-but-resumable scene (the scene clock and every
  // voice are resumed from their exact paused sample instead).
  Howler.autoSuspend = false;

  // Build the sample-locked scene around the shared decoded buffer.
  this.scene = new StormScene(this.sound, this.sound._sprite, {
    // The 250ms lead is measured against the audio clock only; the scene
    // sample stays at 0 until decoding is finished and the context runs.
    lead: 0.25,
    onstart: function() {
      this._rain = this.scene.rainVoice;
    }.bind(this)
  });

  // Begin playing background sounds.
  this.rain();
  this.thunder();
};
Sound.prototype = {
  /**
   * Play a rain loop in the background. Rain starts at scene sample 0 on the
   * rain bus, has no spatial position and loops without ever resetting the
   * shared scene sample. The voice handle becomes available once the decoded
   * scene starts.
   */
  rain: function() {
    this._rain = this.scene.rainVoice || null;
  },

  /**
   * Randomly play thunder sounds periodically. Each clap is triggered at the
   * current scene sample, with its spatial position attached afterward (the
   * panner update does not restart the source or move the scene sample).
   */
  thunder: function() {
    setTimeout(function() {
      // Play the thunder sound in a random position.
      var x = Math.round(100 * (2 - (Math.random() * 4))) / 100;
      var y = Math.round(100 * (2 - (Math.random() * 4))) / 100;
      this._thunder = this.scene.spawnThunder();
      if (this._thunder) {
        // Spatial position can be added while the clap is already playing.
        this.scene.setVoicePos(this._thunder, x, y, -0.5);
      }

      // Schedule the next clap.
      this.thunder();
    }.bind(this), 5000 + Math.round(Math.random() * 15000));
  },

  /**
   * Play lightning in a random location with a random rate/pitch. The random
   * rate only affects this one source; the shared scene sample is unaffected.
   */
  lightning: function() {
    var x = Math.round(100 * (2.5 - (Math.random() * 5))) / 100;
    var y = Math.round(100 * (2.5 - (Math.random() * 5))) / 100;
    var rate = Math.round(100 * (0.4 + (Math.random() * 1.25))) / 100;

    // Play the lightning sound and change the position and rate.
    var voice = this.scene.spawnLightning([x, y, -0.5], rate);
    if (voice) {
      this._lightning = voice;
    }
  },

  /**
   * Setup a speaker in 3D space to play music from.
   * @param  {Number} x x-tile position of speaker.
   * @param  {Number} y y-tile position of speaker.
   */
  speaker: function(x, y) {
    // Speakers queued before the scene starts all join at sample 0, together
    // with the rain. The long music loop stays phase-locked on every speaker
    // and uses the original exponential distance attributes.
    this.scene.addSpeaker(x + 0.5, y + 0.5, -0.5);
  }
};
