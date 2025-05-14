/* globals IMAGINARY */
import MenuMode from './game-mode-menu';

export default class PlayerNumberMode extends MenuMode {
  constructor(game) {
    super(game);
    this._menuItems = Array.from(
      { length: this.game.config.maxPlayers },
      (_, id) => String(id + 1));
  }

  handleEnterMode() {
    super.handleEnterMode();

    const $main = $('.main');
    $main.addClass('mode-menu-num-players');
  }

  handleExitMode() {
    const $main = $('.main');
    $main.removeClass('mode-menu-num-players');

    super.handleExitMode();
  }

  getMenuTitleKeys() {
    return ['choose-num-players'];
  }

  getMenuItems() {
    return this._menuItems;
  }

  getDefaultItemIndex() {
    return this.game.numPlayers - 1;
  }

  processSelection(selectedIndex) {
    super.processSelection(selectedIndex);
    this.game.numPlayers = selectedIndex + 1;
  }
}
