/* globals IMAGINARY */
import {localeInit} from "./i18n";
import GameMode from './game-mode';

export default class TitleMode extends GameMode {
  constructor(game, options) {
    super(game);
    this.options = {...TitleMode.defaultOptions, ...options};
  }

  async preLoadAssets() {
    this.$bg = $(await this.game.loadImgElement('assets/img/menu-bg.png'));
  }

  handleEnterMode() {
    const $overlay = $(this.game.overlay);

    this.$bg.appendTo($overlay);
    this.$bg.addClass('title-bg');

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

    this.elapsedTime = 0;
  }

  handleInputs(inputs, lastInputs, delta, ts0) {
    // If any button was pressed
    if (inputs
      .find((ctrl, i) => ctrl.action && !lastInputs[i].action)) {
      this.triggerEvent('done');
    }

    this.elapsedTime += delta;
    if (this.elapsedTime > this.options.duration) {
      this.triggerEvent('timeout');
    }
  }
}
