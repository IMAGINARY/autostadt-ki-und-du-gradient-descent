/* globals IMAGINARY */
import {localeInit} from "./i18n";
import GameMode from './game-mode';

export default class TitleMode extends GameMode {
  constructor(game, options) {
    super(game);
    this.options = {...TitleMode.defaultOptions, ...options};
  }

  async preLoadAssets() {
    this.$bgSeafloor = $(await this.game.loadImgElement('assets/img/menu-bg-seafloor.png'));
    this.$lines = $(await this.game.loadImgElement('assets/img/lines.svg'));
  }

  handleEnterMode() {
    super.handleEnterMode();

    const $main = $('.main');
    $main.addClass('mode-title');

    const $overlay = $(this.game.overlay);

    this.$bgSeafloor.appendTo($overlay);
    this.$bgSeafloor.addClass('title-bg');

    const $water = $('<div>');
    $water.addClass("title-water-bg");
    $water.appendTo($overlay);

    const $title = $('<div id="title">');
    $title.get().forEach(e=>localeInit(e, 'title'));
    $title.appendTo($overlay);

    const $description1 = $('<div id="title-description-1">');
    $description1.get().forEach(e=>localeInit(e, 'title-description-1'));
    const $bubble1 = $('<div id="title-bubble-1" class="bubble">');
    $description1.appendTo($bubble1);
    $bubble1.appendTo($overlay);
    
    const $description2 = $('<div id="title-description-2">');
    $description2.get().forEach(e=>localeInit(e, 'title-description-2'));
    const $bubble2 = $('<div id="title-bubble-2" class="bubble">');
    $description2.appendTo($bubble2);
    $bubble2.appendTo($overlay);

    this.$lines.appendTo($overlay);
    this.$lines.addClass('title-bg');

    this.elapsedTime = 0;
  }

  handleExitMode() {
    // Cleanup timers, etc. created on handleEnterMode
    const $main = $('.main');
    $main.removeClass('mode-title');

    super.handleExitMode();
  }

  handleInputs(inputs, lastInputs, delta, ts0) {
    // If any button was pressed
    for(let i = 0; i < inputs.length; ++i) {
      if (inputs[i].action && !lastInputs[i].action || inputs[i].direction !== lastInputs[i].direction) {
        this.triggerEvent('done');
        break;
      }
    }

    this.elapsedTime += delta;
    if (this.elapsedTime > this.options.duration) {
      this.triggerEvent('timeout');
    }
  }
}

TitleMode.defaultOptions = {
  duration: 8 * 1000,
};
