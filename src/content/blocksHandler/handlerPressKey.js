import { isXPath, objectHasKey, sleep } from '@/utils/helper';
import { sendMessage } from '@/utils/message';
import { keyDefinitions } from '@/utils/USKeyboardLayout';
import { queryElements } from '../handleSelector';
import { checkExecutionSignal } from '../executionSignal';

const textFieldTags = ['INPUT', 'TEXTAREA'];
const modifierKeys = [
  { name: 'Alt', id: 1 },
  { name: 'Meta', id: 4 },
  { name: 'Shift', id: 8 },
  { name: 'Control', id: 2 },
];

async function pressKeyWithJs({ element, keys, pressTime, signal }) {
  const details = {
    key: '',
    code: '',
    keyCode: '',
    bubbles: true,
    altKey: false,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    cancelable: true,
  };

  for (const eventType of ['keydown', 'keyup']) {
    for (const key of keys) {
      checkExecutionSignal(signal);

      const isLetter = /^[a-zA-Z]$/.test(key);

      const dispatchKeyboardEvent = () => {
        const keyDefinition = keyDefinitions[key] || {
          key,
          keyCode: 0,
          code: isLetter ? `Key${key}` : key,
        };
        const keyboardEvent = new KeyboardEvent(eventType, {
          ...details,
          ...keyDefinition,
        });

        element.dispatchEvent(keyboardEvent);
      };

      const isModifier = modifierKeys.some(({ name }) => name === key);

      if (isModifier) {
        // 修饰键只置位不提前返回：keydown/keyup 两个 pass 都会完整发送事件
        if (eventType === 'keydown') {
          const modKey = key.charAt(0).toLowerCase() + key.slice(1);
          details[modKey] = true;
        }

        dispatchKeyboardEvent();
      } else {
        dispatchKeyboardEvent();

        if (eventType === 'keydown') {
          const isEditable = element.isContentEditable;
          const isTextField = textFieldTags.includes(element.tagName);

          let skipDelay = false;

          if (isEditable || isTextField) {
            const contentKey = isEditable ? 'textContent' : 'value';
            if (isLetter || (keyDefinitions[key] && key.length === 1)) {
              if (isEditable && document.execCommand) {
                document.execCommand('insertText', false, key);
              } else {
                element[contentKey] += key;
              }
            } else if (key === 'Enter') {
              const isSubmitForm =
                element.tagName === 'INPUT' &&
                element.form &&
                !details.ctrlKey &&
                !details.altKey;

              if (isSubmitForm) {
                element.form.submit();
                skipDelay = true;
              } else {
                element[contentKey] += '\r\n';
              }
            }
          }

          // 修复 keyDown/keydown 大小写不一致导致 pressTime 失效
          if (pressTime > 0 && !skipDelay) await sleep(pressTime);
        }
      }
    }
  }
}

async function pressKeyWithCommand({
  keys,
  pressTime,
  actionType,
  signal,
  activeTabId,
}) {
  const commands = [];
  const events =
    actionType === 'multiple-keys' ? ['keyDown'] : ['keyDown', 'keyUp'];

  for (const event of events) {
    let modifierKey = 0;

    for (const key of keys) {
      checkExecutionSignal(signal);

      const command = {
        tabId: activeTabId,
        method: 'Input.dispatchKeyEvent',
        params: {
          key,
          code: '',
          type: event,
          modifiers: 0,
          windowsVirtualKeyCode: 0,
        },
      };
      const definition = keyDefinitions[key];

      if (definition) {
        Object.assign(command.params, definition);

        command.params.windowsVirtualKeyCode = definition.keyCode;
        command.params.nativeVirtualKeyCode = definition.keyCode;

        const isModKey = modifierKeys.find(({ name }) => name === key);
        if (isModKey) modifierKey = isModKey.id;
        else command.params.modifiers = modifierKey;
      }

      if (!actionType || actionType === 'press-key') {
        await sendMessage('debugger:send-command', command, 'background');
      } else {
        const secondEvent = { ...command.params };
        if (!objectHasKey(command, 'text')) {
          secondEvent.text = key;
        }

        commands.push(command.params, secondEvent);
      }

      if (event === 'keyDown' && pressTime > 0) await sleep(pressTime);
    }
  }

  if (actionType === 'multiple-keys') {
    checkExecutionSignal(signal);
    await sendMessage(
      'debugger:type',
      { commands, tabId: activeTabId },
      'background'
    );
  }
}

async function pressKey({ data, debugMode, activeTabId, signal }) {
  let element = document.activeElement;

  if (data.selector) {
    const customElement = await queryElements({
      selector: data.selector,
      findBy: isXPath(data.selector) ? 'xpath' : 'cssSelector',
    });

    element = customElement || element;
  }

  const keys =
    !data.action || data.action === 'press-key'
      ? data.keys.split('+')
      : data.keysToPress.split('');
  const pressKeyFunction = debugMode ? pressKeyWithCommand : pressKeyWithJs;

  checkExecutionSignal(signal);
  await pressKeyFunction({
    keys,
    element,
    activeTabId,
    signal,
    actionType: data.action,
    pressTime: Number.isNaN(+data.pressTime) ? 0 : Math.abs(+data.pressTime),
  });

  return '';
}

export default pressKey;
