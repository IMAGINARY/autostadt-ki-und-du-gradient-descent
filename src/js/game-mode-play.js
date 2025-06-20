import EventEmitter from 'events';
import { createPopper } from '@popperjs/core';

import debugConsole from './debug-console';
import GameMode from './game-mode';
import terrain from './terrain';
import * as waves from './waves';
import BotStrategyBase from './bot-strategies/base';
import BotStrategyRandom from './bot-strategies/random';
import BotStrategyTangentIntersection from './bot-strategies/tangent-intersection';
import BotStrategyGradientDescent from './bot-strategies/gradient-descent';
import {localeInit} from "./i18n";

const WATER_HEIGHT_SCALE = 10;
const NUM_WATER_POINTS = 300;
const WATER_FPS = 5;
const WATER_DISTANCE = 365;
const WATER_LOOP_DURATION = 20 * 1000;

const BOAT_DRAFT = 18;

const TERRAIN_HEIGHT_SCALE = 340;
const NUM_TERRAIN_POINTS = 300;
const MAX_TERRAIN_EXTREMA = 20;
const TERRAIN_MARGIN_WIDTH = 0.1;
const TERRAIN_DISTANCE = 285;

// How far should the boat move on user input per ms
const SPEED_FACTOR = 0.2 / 1000.0;

const PROBE_SIZE = 15;
// must be > 0 for the rope to have a non-zero bounding box area which is required to make gradients work :-(
const PROBE_ROPE_START_X_OFFSET = 0.00001;
const PROBE_DISTANCE_AT_REST = 0.25;
const PROBE_MIN_DURATION = 500;
const PROBE_DELAY = 500;

const TANGENT_LENGTH = 0.02;
const TANGENT_MIN_OPACITY = 0.25;
const TANGENT_OPACITY_FADEOUT_FACTOR = 0.9;
const TANGENT_OPACITY_FADEOUT_DURATION = 500;

const TREASURE_SIZE = 0.03;

const START_SEQUENCE_FST_DELAY = 500;
const START_SEQUENCE_AFTER_FST_DELAY = 2000;
const START_SEQUENCE_AFTER_SND_DELAY = 1000;

const UNCOVER_DURATION = 2000;
const ENDING_SEQUENCE_FST_DELAY = 0;
const ENDING_SEQUENCE_SND_DELAY = 1000;
const ENDING_SEQUENCE_RESTART_DELAY = 5000;

export default class PlayMode extends GameMode {

  constructor(game) {
    super(game);
    const wavesPoints = Array(NUM_WATER_POINTS).fill(null);
    this.wavesPoints = t => waves.points(wavesPoints, t, game.draw.width(), WATER_HEIGHT_SCALE);
    this.bot = null;
  }

  async preLoadAssets() {
    const internalAssetUrls = {
      ships: ['assets/img/ship.svg'],
      treasureClosed: 'assets/img/treasure-closed.svg',
      treasureOpened: 'assets/img/treasure-opened.svg',
    }
    const assetUrls = { ... internalAssetUrls, ... this.game.config.externalAssets ?? {} };

    this.shipSymbols = await Promise.all(assetUrls.ships.map((s) => this.game.loadSVGSymbol(s)));
    this.shipSymbols.forEach(s => s.attr({ overflow: 'visible' }));
    this.treasureClosedSymbol = await this.game.loadSVGSymbol(assetUrls.treasureClosed);
    this.treasureClosedSymbol.attr({ overflow: 'visible' });
    this.treasureOpenedSymbol = await this.game.loadSVGSymbol(assetUrls.treasureOpened);
    this.treasureOpenedSymbol.attr({ overflow: 'visible' });

    this.linesImg = await this.game.loadImgElement('assets/img/lines.svg');
  }

  handleEnterMode() {
    super.handleEnterMode();

    const $main = $('.main');
    $main.addClass('mode-play');

    const { draw, config, numPlayers, botType } = this.game;

    this.isGameOver = false;
    this.discardInputs = false;

    this.remainingTime = config.maxTime * 1000;

    this.tangents = [];

    this.$overlay = $('<div class="play" />').appendTo(this.game.overlay);
    const $gameStats = $('<div class="game-stats"/>').appendTo(this.$overlay);
    this.$gameState = $gameStats;
    const $gameStatsWrapper = $('<div class="game-stats-wrapper"/>').appendTo($gameStats);

    const $remainingTimeContainer = $('<div class="remaining-time"/>')
      .appendTo($gameStatsWrapper);
    const $remainingTimeLabel = $('<span class="label"/>');
    localeInit($remainingTimeLabel, 'remaining-time');
    $remainingTimeLabel.appendTo($remainingTimeContainer)
    if (config.maxTime === Number.POSITIVE_INFINITY)
      $remainingTimeContainer.hide()

    const $remainingProbesContainer = $('<div class="remaining-probes"/>')
      .appendTo($gameStatsWrapper);
    this.$remainingTime = $('<span class="counter"/>')
      .appendTo($remainingTimeContainer);
    if (config.maxProbes === Number.POSITIVE_INFINITY)
      $remainingProbesContainer.hide()

    this.$endingSequenceContainer = $('<div />').appendTo(this.$overlay);

    const modeGroup = draw.group()
      .addClass('play')
      .addClass('draw')
      .translate(0, WATER_DISTANCE);

    const padRemainingProbes = num => pad(num, String(this.game.config.maxProbes).length, ' ');
    const createPlayer = (playerIndex, numPlayers, cssClass, isBot = false) => {
      if(numPlayers > 3) {
        throw new Error('The implementation for Autostadt "KI und DU" only works for up to 3 players including the bot.' );
      }
      let x;
      if(isBot) {
        x = 0.5;
      } else {
        if(playerIndex === 0) {
          x = 0.25;
        } else {
          x = 0.75;
        }
      }

      const group = modeGroup.group();
      group
        .addClass(cssClass)
        .transform({ translateX: x * draw.width() });

      const shipSymbolIndex = isBot ? this.shipSymbols.length - 1 : playerIndex % this.shipSymbols.length;
      const boat = group.use(this.shipSymbols[shipSymbolIndex])
        .center(0, BOAT_DRAFT);

      const probeRopeGradient = modeGroup.gradient('linear', function(add) {
        add.stop({ offset: 0 }).addClass('probe-rope-gradient-stop-0');
        add.stop({ offset: 1 }).addClass('probe-rope-gradient-stop-20');
        add.stop({ offset: 1 }).addClass('probe-rope-gradient-stop-100');
      }).from(0, 0).to(0, 1).addClass(cssClass);

      const probeParent = group.group();
      const probe = probeParent.group();
      const probeY = TERRAIN_DISTANCE * PROBE_DISTANCE_AT_REST;
      const probeRope = probe.line(PROBE_ROPE_START_X_OFFSET, BOAT_DRAFT, 0, probeY - PROBE_SIZE / 2).stroke(probeRopeGradient).addClass("probe-rope");
      const probeCircle = probe.circle(PROBE_SIZE).center(0, probeY).addClass("probe")

      const doProbe = function (terrainHeight) {
        this.probing = true;
        this.remainingProbes = Math.max(0, this.remainingProbes - 1);
        this.$remainingProbes.text(padRemainingProbes(this.remainingProbes));
        if (this.remainingProbes === 0)
          this.$remainingProbes.addClass("blinking");
        const probeHeight = TERRAIN_DISTANCE + TERRAIN_HEIGHT_SCALE * terrainHeight;
        const probeDuration = probeHeight * (PROBE_MIN_DURATION / TERRAIN_DISTANCE);

        const probeDown = probeCircle.animate(probeDuration, 0, 'now')
          .cy(probeHeight);
        const probeRopeDown = probeRope.animate(probeDuration, 0, 'now')
          .plot(PROBE_ROPE_START_X_OFFSET, BOAT_DRAFT, 0, probeHeight - PROBE_SIZE / 2);

        const yUp = this.remainingProbes > 0 ? TERRAIN_DISTANCE
          * PROBE_DISTANCE_AT_REST : BOAT_DRAFT + PROBE_SIZE;
        const probeUp = probeDown.animate(probeDuration, PROBE_DELAY)
          .cy(yUp)
          .after(() => this.probing = false);
        const probeRopeUp = probeRopeDown.animate(probeDuration, PROBE_DELAY)
          .plot(PROBE_ROPE_START_X_OFFSET, BOAT_DRAFT, 0, yUp - PROBE_SIZE / 2);

        return {
          down: new Promise(resolve => probeDown.after(resolve)),
          up: new Promise(resolve => probeUp.after(resolve)),
        }
      }

      // Add an element for displaying the number of remaining probes
      const $myRemainingProbesContainer = $('<span>');
        $myRemainingProbesContainer.addClass(cssClass);
      $myRemainingProbesContainer.appendTo($remainingProbesContainer);
      const $myRemainingProbesLabel = $('<span class="label">');
      localeInit($myRemainingProbesLabel, 'remaining-probes');
      $myRemainingProbesLabel.appendTo($myRemainingProbesContainer);
      const $myRemainingProbesValue = $(`<span class="counter">`);
      $myRemainingProbesValue.text(config.maxProbes);
      $myRemainingProbesValue.appendTo($myRemainingProbesContainer);

      // Move boat in front of the probe
      boat.front();

      return {
        id: playerIndex,
        cssClass: cssClass,
        group: group,
        boat: boat,
        probe: probe,
        doProbe: doProbe,
        x: x,
        lastX: x,
        flipX: false,
        _probing: false,
        _probeEventEmitter: new EventEmitter(),
        set probing(p) {
          const probeTurnedOff = this._probing && !p;
          this._probing = p;
          if (probeTurnedOff)
            this._probeEventEmitter.emit("probe-off");
        },
        get probing() {
          return this._probing;
        },
        probingDone: async function () {
          if (!this.probing)
            return;
          await new Promise(resolve => this._probeEventEmitter.addListener("probe-off", resolve));
        },
        hideProbe: function () {
          probe.hide();
        },
        remainingProbes: config.maxProbes,
        $remainingProbes: $myRemainingProbesValue,
      };
    };

    // Create a boat for each player
    const addBot = botType && botType !== 'none';
    this.players = Array(numPlayers)
      .fill(null)
      .map((_, playerIndex) => createPlayer(
        playerIndex,
        numPlayers + (addBot ? 1 : 0),
        `player-${playerIndex}`)
      );
    if (addBot) {
      const botStrategyClass = (() => {
        switch (botType) {
          case 'random':
            return BotStrategyRandom;
          case 'newton':
            return BotStrategyNewton;
          case 'gradient-descent':
            return BotStrategyGradientDescent;
          case 'tangent-intersection':
            return BotStrategyTangentIntersection;
          default:
            return BotStrategyBase;
        }
      })();
      const botStrategy = new botStrategyClass(
        TERRAIN_MARGIN_WIDTH,
        1 - TERRAIN_MARGIN_WIDTH,
        TREASURE_SIZE
      );
      const bot = {};
      bot.type = botType;
      bot.player = createPlayer(numPlayers, numPlayers + 1, 'player-bot', true);
      const nextTarget = () => botStrategy.getNextProbeLocation(
        this.tangents,
        bot.player,
        bot.player.id,
        this.players,
      );
      bot.targetX = nextTarget();
      bot.tangentListener = () => bot.targetX = nextTarget();
      this.players.push(bot.player);
      this.events.addListener('new-tangent', bot.tangentListener);
      this.bot = bot;
    } else {
      this.bot = null;
    }

    this.water = modeGroup.group().attr('id', 'water').addClass('water');

    const extraPoints = [
      [game.draw.width(), 0],
      [game.draw.width(), game.draw.height()],
      [0, game.draw.height()],
      [0, 0],
    ];
    waves.animatedSVGPolyline(this.water,
      NUM_WATER_POINTS,
      (WATER_LOOP_DURATION / 1000) * WATER_FPS,
      game.draw.width(),
      WATER_HEIGHT_SCALE,
      WATER_LOOP_DURATION,
      extraPoints,
      true,
    );
    const waterGradient = this.water.gradient('linear', function(add) {
      add.stop({offset: 0}).addClass('water-gradient-stop-top');
      add.stop({offset: 1 - WATER_DISTANCE / game.draw.height() }).addClass('water-gradient-stop-bottom');
      add.stop({offset: 1});
    }).from(0, 0).to(0, 1);

    this.water.fill(waterGradient);

    this.groundGroup = modeGroup.group();
    const newTerrainHeights = () => {
      const terrainOptions = { marginWidth: TERRAIN_MARGIN_WIDTH, tilt: game.config.maxDepthTilt };
      return terrain(MAX_TERRAIN_EXTREMA, NUM_TERRAIN_POINTS, terrainOptions);
    }
    const terrainHeights = game.map ? game.map : newTerrainHeights();
    const terrainPoints = terrainHeights.map((h, i) => [
      draw.width() * (i / (terrainHeights.length - 1)),
      TERRAIN_HEIGHT_SCALE * h,
    ]).concat([
      [2 * draw.width(), 0],
      [2 * draw.width(), draw.height()],
      [-draw.width(), draw.height()],
      [-draw.width(), 0],
    ]);
    this.terrainHeights = terrainHeights;
    this.treasureLocation = this.locateTreasure();
    debugConsole.log("Map:", terrainHeights);
    debugConsole.log("Treasure location:", this.treasureLocation);

    this.treasureGroup = modeGroup.group()
      .addClass('treasure')
      .addClass('player-none')
      .transform({
        translateX: this.treasureLocation.x * draw.width(),
        translateY: TERRAIN_DISTANCE + this.treasureLocation.y * TERRAIN_HEIGHT_SCALE,
      });
    this.treasureClosed = this.treasureGroup.use(this.treasureClosedSymbol).hide();
    this.treasureOpened = this.treasureGroup.use(this.treasureOpenedSymbol).hide();

    this.ground = this.groundGroup.polygon(terrainPoints)
      .fill('black')
      .addClass('ground')
      .translate(0, TERRAIN_DISTANCE);

    this.groundGroup.addClass("ground-group");
    if (!config.showSeaFloor)
      this.groundGroup.addClass("clip");

    this.groundGroup.node.style.setProperty('--clip-center-x', `${(1 + this.treasureLocation.x) * draw.width()}px`);

    // Uncomment to draw a box around the terrain area - useful for positioning the terrain and other UI element
    // this.groundGroup.rect(draw.width(), TERRAIN_HEIGHT_SCALE).move(0, TERRAIN_DISTANCE).stroke("black");

    this.tangentGroup = modeGroup.group()
      .translate(0, TERRAIN_DISTANCE);

    // Set z ordering of elements
    [this.groundGroup, this.tangentGroup, this.water, this.treasureGroup].forEach(e => e.front());

    this.discardInputs = true;
    this.gameStartSequencePromise = this.showGameStartSequence(
        localeInit($('<span>'), 'objective'),
        localeInit($('<span>'), 'go'),
        () => this.discardInputs = false
    );
  }

  handleExitMode() {
    // Cleanup timers, etc. created on handleEnterMode
    if (this.bot !== null)
      this.events.removeListener('new-tangent', this.bot.tangentListener);

    const $main = $('.main');
    $main.removeClass('mode-play');

    super.handleExitMode();
  }

  static buildBotInput(bot) {
    const botInput = { direction: 0, action: false };
    const botLastInput = { direction: 0, action: false };

    const { player, targetX } = bot;
    const { x, lastX } = player;
    const [lower, upper] = x < lastX ? [x, lastX] : [lastX, x];

    if (lower <= targetX && targetX <= upper) {
      // It's time to probe!
      player.lastX = x;
      player.x = targetX;
      botInput.action = true;
    } else {
      // Navigate towards targetX
      botInput.direction = Math.sign(targetX - player.x);
    }

    return {
      input: botInput,
      lastInput: botLastInput,
    }
  }

  handleInputs(inputs, lastInputs, delta, ts) {
    // Move the boats or check if they're lowering the probe
    const { draw, config, numPlayers } = this.game;

    // Some game states do not allow user input
    if (this.discardInputs)
      return;

    // Leave game mode when the game is over and a player pressed the action button
    if (this.isGameOver) {
      const action = inputs.findIndex((input, i) => actionPressed(input, lastInputs[i])) !== -1;
      if (this.isGameOver && action) {
        this.discardInputs = true;
        this.triggerEvent('done');
      }
      return;
    }

    // Update remaining time
    const newRemainingTime = Math.max(0, this.remainingTime - delta);
    if (this.remainingTime !== newRemainingTime) {
      this.remainingTime = newRemainingTime;
    }

    // Check whether the game is lost
    if (this.remainingTime === 0) {
      debugConsole.log("Time is up - GAME OVER!");
      this.gameOver(async () => this.showLoseSequenceTimeIsUp());
      return;
    } else if (this.players.reduce((a, c) => a + c.remainingProbes, 0) === 0) {
      const anyoneProbing = this.players.reduce((a, c) => a || c.probing, false);
      if (!anyoneProbing) {
        debugConsole.log("No probes left - GAME OVER!");
        this.gameOver(async () => this.showLoseSequenceNoProbesLeft());
        return;
      }
    }

    // Discard inputs that don't belong to an active player
    inputs = inputs.slice(0, numPlayers);
    lastInputs = lastInputs.slice(0, numPlayers);

    // If there is a bot, create fake inputs for it
    if (this.bot !== null && this.bot.player.remainingProbes > 0) {
      const { input, lastInput } = PlayMode.buildBotInput(this.bot);
      inputs.push(input);
      lastInputs.push(lastInput);
    }

    // Regular move & probe logic
    this.processInputs(inputs, lastInputs, delta, ts);
  }

  processInputs(inputs, lastInputs, delta, ts) {
    inputs
      .forEach((input, playerIndex) => {
        const lastInput = lastInputs[playerIndex];
        const action = actionPressed(input, lastInput);

        const player = this.players[playerIndex];
        if (player && !player.probing && !this.isGameOver) {
          player.lastX = player.x;
          player.x += SPEED_FACTOR * (delta * input.direction);
          player.x = Math.min(Math.max(TERRAIN_MARGIN_WIDTH, player.x),
            1.0 - TERRAIN_MARGIN_WIDTH);
          // TODO: Limit bot position to bot.targetX
          player.flipX = input.direction === 0 ? player.flipX : input.direction === -1;
          if (action && player.remainingProbes > 0) {
            // Switch to probe mode
            // Lower the probe, wait and raise it again
            const terrainHeight = this.terrainHeight(player.x);
            const { down, up } = player.doProbe(terrainHeight);
            // Todo: If the game ends, this tangent is still added. It should be cancellable.
            down.then(() => this.addTangent(player));
            const treasureFound = Math.abs(player.x - this.treasureLocation.x) <= TREASURE_SIZE
              / 2;
            down.then(async () => {
              if (treasureFound && !this.isGameOver) {
                debugConsole.log("Treasure found - GAME OVER!");
                this.treasureGroup.removeClass('player-none').addClass(player.cssClass);
                await this.gameOver(async () => this.showWinSequence(player));
              }
            });

            debugConsole.log(`Player ${playerIndex} is probing at:`,
              { x: player.x, y: terrainHeight });
          }
        }
      });
  }

  draw(delta, ts) {
    const { draw } = this.game;
    // Move boats
    // Draw bottom
    // etc...

    const minutes = Math.floor(( this.remainingTime / 1000 + 1 ) / 60);
    const seconds = Math.ceil(( this.remainingTime / 1000 ) % 60) % 60;
    const remainingTimeText = `${minutes}`.padStart(2, '0') + ':' + `${seconds}`.padStart(2, '0');
    if(remainingTimeText !== this.$remainingTime.text()) {
      this.$remainingTime.text(remainingTimeText);
    }
    if (this.remainingTime === 0)
      this.$remainingTime.addClass("blinking");

    // The water animation uses SVG animations (via SMIL), so we have to use it's timestamp for
    // animating the boat's rotation and vertical position.
    const waterTs = draw.node.getCurrentTime() * 1000;

    this.players.forEach((player, playerIndex) => {
      const x = player.x;
      const y = WATER_HEIGHT_SCALE * waves.height(x, waterTs / WATER_LOOP_DURATION);
      const slope = WATER_HEIGHT_SCALE * waves.slope(x, waterTs / WATER_LOOP_DURATION);
      const angle = 0.25 * 180 * Math.atan2(slope, draw.width()) / Math.PI;
      // Animating by setting CSS attributes seems to be more efficient than setting SVG attributes
      player.boat.node.style.transform = `rotate(${angle}deg) scale(${player.flipX ? -1 : 1},1)`;
      player.group.node.style.transform = `translate(${x * draw.width()}px,${y}px)`;
    });
  }

  terrainHeight(x) {
    return this.terrainHeightExt(x).value;
  }

  terrainHeightExt(x) {
    const xInArray = (this.terrainHeights.length - 1) * x;
    const tmpIndex = Math.floor(xInArray);
    const i0 = tmpIndex === this.terrainHeights.length - 1 ? tmpIndex - 1 : tmpIndex;
    const i1 = i0 + 1;
    const h0 = this.terrainHeights[i0];
    const h1 = this.terrainHeights[i1];
    const t = xInArray - i0;
    return {
      x: x,
      value: h0 + t * (h1 - h0),
      slope: (h1 - h0) * (this.terrainHeights.length - 1),
    };
  }

  locateTreasure() {
    const argmax = array => [].reduce.call(array, (m, c, i, arr) => c > arr[m] ? i : m, 0);
    const margin = Math.floor(this.terrainHeights.length * TERRAIN_MARGIN_WIDTH) + 1;
    const terrainHeightNoMargin = this.terrainHeights.slice(
      margin,
      this.terrainHeights.length - margin
    );
    const treasureIndex = margin + argmax(terrainHeightNoMargin);
    return {
      x: treasureIndex / (this.terrainHeights.length - 1),
      y: this.terrainHeights[treasureIndex],
    };
  }

  addTangent(player) {
    // Reduce the opacity of previously added tangents of this player
    const offsetMult = (v, factor, offset) => offset + (v - offset) * factor;
    this.tangentGroup.find(player.cssClass)
      .each(function () {
        const o = offsetMult(this.opacity(), TANGENT_OPACITY_FADEOUT_FACTOR, TANGENT_MIN_OPACITY);
        this.animate(TANGENT_OPACITY_FADEOUT_DURATION).opacity(o);
      });

    // Add the new tangent
    const { draw } = this.game;
    const width = draw.width();
    const tangent = this.terrainHeightExt(player.x);
    const { x, value, slope } = tangent;
    const angle = 180 * Math.atan2(slope * TERRAIN_HEIGHT_SCALE, width) / Math.PI;
    this.tangentGroup.line(-width * TANGENT_LENGTH / 2, 0, width * TANGENT_LENGTH / 2, 0,)
      .addClass(player.cssClass)
      .addClass('tangent')
      .transform({
        translateX: width * x,
        translateY: TERRAIN_HEIGHT_SCALE * value,
        rotate: angle,
      });

    this.tangents.push(tangent);
    this.tangents.sort((a, b) => a.x - b.x);
    this.events.emit('new-tangent', tangent, this.tangents.indexOf(tangent), this.tangents);
  }

  async gameOver(endingSequenceCallback) {
    // The game is now over, so a player that lowered the probe later can not win anymore.
    this.isGameOver = true;

    // Disable all inputs until the ending sequence is over.
    this.discardInputs = true;
    this.treasureClosed.show();

    // Hide the game state
    this.$gameState.hide();

    // Add the line overlay
    this.$overlay.append(this.linesImg);

    const uncoverGroundPromise = this.uncoverGround();
    await Promise.all(this.players.map(p => p.probingDone()));

    // Hide the probes
    this.players.forEach(p => p.hideProbe());

    await this.gameStartSequencePromise;
    await endingSequenceCallback();
    this.discardInputs = false;
    await uncoverGroundPromise;
  }

  async uncoverGround(duration = UNCOVER_DURATION) {
    const { draw } = this.game;

    // uncover using a CSS transition
    const groundGroupStyle = this.groundGroup.node.style;
    groundGroupStyle.setProperty('--clip-transition-duration', `${duration}ms`);
    groundGroupStyle.setProperty('--clip-width', `${draw.width() * 2}px`);
    // TODO: Wait for the CSS transition to end instead of using a timeout.
    return new Promise((resolve) => setTimeout(resolve, duration));
  }

  async showGameStartSequence(firstMessageElem,
                             secondMessageElem,
                             secondMessageCallback = Function.prototype,
                             cssClasses = []) {
    const $firstMessageDiv = $('<div class="line line-1">').append(firstMessageElem);
    const $secondMessageDiv = $('<div class="line line-2">').append(secondMessageElem)
        .css('visibility', 'hidden');

    const $startSequenceDiv = $('<div class="announcement-sequences-text game-start" />')
        .addClass(cssClasses)
        .append([$firstMessageDiv, $secondMessageDiv]);

    await delay(START_SEQUENCE_FST_DELAY);
    this.$endingSequenceContainer.empty().append($startSequenceDiv);

    await delay(START_SEQUENCE_AFTER_FST_DELAY);

    $secondMessageDiv.css("visibility", "visible");
    secondMessageCallback();

    await delay(START_SEQUENCE_AFTER_SND_DELAY);
    this.$endingSequenceContainer.empty();
  }

  async showWinSequence(winner) {
    const {draw} = this.game;

    const left = winner.x * draw.width();
    const top = WATER_DISTANCE + BOAT_DRAFT;

    const $winAnnouncement = $('<span class="win-announcement-part">').append(
        localeInit($('<span class="win-announcement-part-1">'), 'win-announcement-part-1'),
        localeInit($('<span class="win-announcement-part-2">'), 'win-announcement-part-2'),
        $('<span class="win-announcement-player">').text(winner.id + 1),
        localeInit($('<span class="win-announcement-part-3">'), 'win-announcement-part-3'),
        $(' ')
    );
    const randomIdx = arr => Math.floor(Math.random() * (arr.length - 1));
    const $treasure = localeInit($('<span>'), 'treasures', randomIdx(IMAGINARY.i18n.t('treasures')));

    /*
    // Uncomment for cycling through treasures. Useful for style and line break adjustments.
    let treasureIdx = 0;
    window.addEventListener('keypress', (e) => {
      if(e.key=== 't') {
        treasureIdx = (treasureIdx + 1) % IMAGINARY.i18n.t('treasures').length;
        localeInit($treasure, 'treasures', treasureIdx);
      }
    });
    */

    const $firstMessageDiv = $winAnnouncement;
    const $secondMessageDiv = $treasure
        .css('visibility', 'hidden');

    const $container = $('<div>').append([$firstMessageDiv, $secondMessageDiv]);

    const $endingSequenceDiv = $('<div class="announcement-sequences-text bubble game-won" />')
        .addClass(left < draw.width() / 2 ? 'arrow-left' : 'arrow-right')
        .css({'--anchor-x': `${left}px`, '--anchor-y': `${top}px`})
        .append($container);

    await delay(ENDING_SEQUENCE_FST_DELAY);
    this.$endingSequenceContainer.empty().append($endingSequenceDiv);

    $secondMessageDiv.css("visibility", "visible");

    this.treasureOpened.show();
    this.treasureClosed.hide();

    await delay(ENDING_SEQUENCE_RESTART_DELAY);
    this.showRestartHint();
  }

  async showLoseSequenceTimeIsUp() {
    await this.showLoseSequence(
        localeInit($('<span>'), 'time-is-up'),
        localeInit($('<span>'), 'game-over'),
    );
  }

  async showLoseSequenceNoProbesLeft() {
    await this.showLoseSequence(
        localeInit($('<span>'), 'no-probes-left'),
        localeInit($('<span>'), 'game-over'),
    );
  }

  async showLoseSequence(firstMessageElem,
                             secondMessageElem,
                             secondMessageCallback = Function.prototype,
                             cssClasses = []) {
    const $firstMessageDiv = $('<div class="line line-1">').append(firstMessageElem);
    const $secondMessageDiv = $('<div class="line line-2">').append(secondMessageElem)
        .css('visibility', 'hidden');

    const $startSequenceDiv = $('<div class="announcement-sequences-text game-lost" />')
        .addClass(cssClasses)
        .append([$firstMessageDiv, $secondMessageDiv]);

    await delay(ENDING_SEQUENCE_FST_DELAY);
    this.$endingSequenceContainer.empty().append($startSequenceDiv);

    await delay(ENDING_SEQUENCE_SND_DELAY);
    $secondMessageDiv.css("visibility", "visible");
    secondMessageCallback();

    await delay(ENDING_SEQUENCE_RESTART_DELAY);
    this.showRestartHint();
  }

  showRestartHint() {
    const $restartDiv = $('<div class="restart-hint bubble">')

    // Put the restart hint on the screen side opposite of the treasure
    $restartDiv.addClass(this.treasureLocation.x > 0.5 ? 'left' : 'right');

    const $restartText = $('<span>').appendTo($restartDiv);
    localeInit($restartText, 'press-to-restart');

    this.$endingSequenceContainer.append($restartDiv);

    // Add the end title text
    const $endTitle = $('<div id="game-over-title">');
    localeInit($endTitle, 'game-over-title');
    $endTitle.appendTo(this.$overlay);
  }
}

function actionPressed(input, lastInput) {
  return input.action && !lastInput.action;
}

function pad(num, places, char) {
  return String(num).padStart(places, char)
}

function createAutoUpdatingPopper(reference, popper, options) {
  const popperInstance = createPopper(reference, popper, options);
  const observer = new MutationObserver(() => popperInstance.update());
  observer.observe(popper, {subtree: true, childList: true, characterData: true});
  return popperInstance;
}

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
