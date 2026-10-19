import FindElement from '../../src/utils/FindElement';
import handleSelector, {
  getDocumentCtx,
} from '../../src/content/handleSelector';
import * as utils from '../../src/content/utils';
import * as path from '../../src/utils/selectorPath';
import findSelector from '../../src/lib/findSelector';
import pressKey from '../../src/content/blocksHandler/handlerPressKey';
import conditions from '../../src/content/blocksHandler/handlerConditions';
import loopElements from '../../src/content/blocksHandler/handlerLoopElements';

window.automaTest = {
  FindElement,
  handleSelector,
  getDocumentCtx,
  utils,
  path,
  findSelector,
  pressKey,
  conditions,
  loopElements,
};
