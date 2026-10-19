<template>
  <svg
    v-if="!disabled"
    class="automa-element-highlighter"
    style="
      height: 100%;
      width: 100%;
      top: 0;
      left: 0;
      pointer-events: none;
      position: fixed;
      z-index: 999999;
    "
  >
    <shared-element-highlighter
      :items="elementsState.hovered"
      stroke="#fbbf24"
      fill="rgba(251, 191, 36, 0.1)"
    />
    <shared-element-highlighter
      :items="elementsState.selected"
      stroke="#2563EB"
      active-stroke="#f87171"
      fill="rgba(37, 99, 235, 0.1)"
      active-fill="rgba(248, 113, 113, 0.1)"
    />
  </svg>
  <teleport to="html">
    <div
      v-if="!disabled"
      id="automa-selector-overlay"
      style="
        z-index: 9999999;
        position: fixed;
        left: 0;
        top: 0;
        width: 100%;
        height: 100%;
      "
    ></div>
  </teleport>
</template>
<script setup>
import { reactive, watch, onBeforeUnmount, toRaw } from 'vue';
import { finder } from '@/lib/findSelector';
import { debounce } from '@/utils/helper';
import getSelectorOptions from '@/content/elementSelector/getSelectorOptions';
import { generateXPath, getElementPath, getElementRect } from '@/content/utils';
import findElementList from '@/content/elementSelector/listSelector';
import generateElementsSelector from '@/content/elementSelector/generateElementsSelector';
import SharedElementHighlighter from './SharedElementHighlighter.vue';

const props = defineProps({
  selectorType: {
    type: String,
    default: 'css',
  },
  selectedEls: {
    type: Array,
    default: () => [],
  },
  selectorSettings: {
    type: Object,
    default: () => ({}),
  },
  list: Boolean,
  hide: Boolean,
  pause: Boolean,
  disabled: Boolean,
  onlyInList: Boolean,
  withAttributes: Boolean,
});
const emit = defineEmits(['selected']);

let frameElement = null;
let frameElementRect = null;
let lastScrollPosY = window.scrollY;
let lastScrollPosX = window.scrollX;
const mousePosition = {
  x: 0,
  y: 0,
};

let hoveredElements = [];
const elementsState = reactive({
  hovered: [],
  selected: [],
});

const onScroll = debounce(() => {
  if (props.disabled) return;

  hoveredElements = [];
  elementsState.hovered = [];

  const yPos = window.scrollY - lastScrollPosY;
  const xPos = window.scrollX - lastScrollPosX;

  elementsState.selected.forEach((_, index) => {
    elementsState.selected[index].x -= xPos;
    elementsState.selected[index].y -= yPos;
  });

  lastScrollPosX = window.scrollX;
  lastScrollPosY = window.scrollY;
}, 100);

function getElementRectWithOffset(
  element,
  { withAttribute, withElOptions } = {}
) {
  const rect = getElementRect(element, withAttribute);

  if (frameElementRect) {
    rect.y += frameElementRect.top;
    rect.x += frameElementRect.left;
  }
  if (withElOptions && element.tagName === 'SELECT') {
    rect.options = Array.from(element.querySelectorAll('option')).map((el) => ({
      value: el.value,
      name: el.innerText,
    }));
  }

  return rect;
}
function removeElementsList() {
  const prevSelectedList = document.querySelectorAll('[automa-el-list]');
  prevSelectedList.forEach((el) => {
    el.removeAttribute('automa-el-list');
  });
}
function resetFramesElements(options = {}) {
  const elements = document.querySelectorAll('iframe, frame');

  elements.forEach((element) => {
    element.contentWindow.postMessage(
      {
        ...options,
        type: 'automa:reset-element-selector',
      },
      '*'
    );
  });
}
function retrieveElementsRect({ clientX, clientY, target: eventTarget }, type) {
  const isAutomaContainer = eventTarget.classList.contains(
    'automa-element-selector'
  );
  if (props.disabled || isAutomaContainer) return;

  const isSelectList = props.list && props.selectorType === 'css';

  let { 1: target } = document.elementsFromPoint(clientX, clientY);
  if (!target) return;

  const onlyInList = props.onlyInList && elementsState.selected.length > 0;
  const framesEl = ['IFRAME', 'FRAME'];

  if (framesEl.includes(target.tagName)) {
    if (type === 'selected') removeElementsList();

    if (target.contentDocument) {
      frameElement = target;
      frameElementRect = target.getBoundingClientRect();

      const yPos = clientY - frameElementRect.top;
      const xPos = clientX - frameElementRect.left;

      target = target.contentDocument.elementFromPoint(xPos, yPos);
    } else {
      const { top, left } = target.getBoundingClientRect();
      const payload = {
        top,
        left,
        clientX,
        clientY,
        onlyInList,
        list: isSelectList,
        type: 'automa:get-element-rect',
        withAttributes: props.withAttributes,
      };

      if (type === 'selected') {
        Object.assign(payload, {
          click: true,
          selectorType: props.selectorType,
          selectorSettings: toRaw(props.selectorSettings),
        });
      }

      target.contentWindow.postMessage(payload, '*');
      frameElement = target;
      frameElementRect = target.getBoundingClientRect();
      return;
    }
  } else {
    frameElement = null;
    frameElementRect = null;
  }

  // open Shadow DOM 中逐层命中实际元素；XPath 不跨 ShadowRoot。
  if (props.selectorType === 'css') {
    let inner = target.shadowRoot?.elementFromPoint(
      clientX - (frameElementRect?.left || 0),
      clientY - (frameElementRect?.top || 0)
    );
    while (inner && inner !== target) {
      target = inner;
      inner = target.shadowRoot?.elementFromPoint(
        clientX - (frameElementRect?.left || 0),
        clientY - (frameElementRect?.top || 0)
      );
    }
  }

  let elementsRect = [];
  const withElOptions = type === 'selected';
  const withAttribute = props.withAttributes && type === 'selected';

  if (isSelectList) {
    const elements =
      findElementList(target, {
        onlyInList,
        frameElement,
      }) || [];

    if (type === 'hovered') hoveredElements = elements;

    elementsRect = elements.map((el) =>
      getElementRectWithOffset(el, { withAttribute, withElOptions })
    );
  } else {
    if (type === 'hovered') hoveredElements = [target];

    elementsRect = [
      getElementRectWithOffset(target, { withAttribute, withElOptions }),
    ];
  }

  elementsState[type] = elementsRect;

  if (type === 'selected') {
    if (!frameElement) resetFramesElements();

    const selectorOptions = getSelectorOptions(props.selectorSettings);
    let selector = generateElementsSelector({
      target,
      frameElement,
      hoveredElements,
      list: isSelectList,
      selectorType: props.selectorType,
      selectorSettings: selectorOptions,
    });

    if (frameElement) {
      const frameSelector =
        props.selectorType === 'css'
          ? finder(frameElement, selectorOptions)
          : generateXPath(frameElement);
      selector = `${frameSelector} |> ${selector}`;
    }

    const selectElements = elementsRect.reduce((acc, rect, index) => {
      if (rect.tagName !== 'SELECT') return acc;

      acc.push({ ...rect, elIndex: index });

      return acc;
    }, []);

    emit('selected', {
      selector,
      selectElements,
      elements: elementsRect,
      path: getElementPath(target),
    });
  }
}
function onMousemove(event) {
  if (props.pause) return;

  mousePosition.x = event.clientX;
  mousePosition.y = event.clientY;
  retrieveElementsRect(event, 'hovered');
}
function onKeydown(event) {
  if (props.pause || event.repeat || event.code !== 'Space') return;

  const { 1: selectedElement } = document.elementsFromPoint(
    mousePosition.x,
    mousePosition.y
  );
  if (selectedElement.id === 'automa-selector-overlay') return;

  event.preventDefault();
  event.stopPropagation();

  retrieveElementsRect(
    {
      target: selectedElement,
      clientX: mousePosition.x,
      clientY: mousePosition.y,
    },
    'selected'
  );
}
function onMousedown(event) {
  if (event.target.id === 'automa-selector-overlay') {
    event.preventDefault();
    event.stopPropagation();
  }
  retrieveElementsRect(event, 'selected');
}
function onMessage({ data }) {
  if (data.type !== 'automa:iframe-element-rect') return;
  if (data.click) {
    const frameSelector =
      props.selectorType === 'css'
        ? finder(frameElement, { tagName: () => true })
        : generateXPath(frameElement);

    emit('selected', {
      elements: data.elements,
      selector: `${frameSelector} |> ${data.selector}`,
    });
  }

  const key = data.click ? 'selected' : 'hovered';
  elementsState[key] = data.elements;
}
function attachListeners() {
  window.addEventListener('scroll', onScroll);
  window.addEventListener('message', onMessage);
  document.addEventListener('keydown', onKeydown);
  window.addEventListener('mousemove', onMousemove);
  document.addEventListener('mousedown', onMousedown);
}
function detachListeners() {
  window.removeEventListener('scroll', onScroll);
  window.removeEventListener('message', onMessage);
  document.removeEventListener('keydown', onKeydown);
  window.removeEventListener('mousemove', onMousemove);
  document.removeEventListener('mousedown', onMousedown);
}

watch(
  () => [props.list, props.disabled],
  () => {
    removeElementsList();
    resetFramesElements({ clearCache: true });
  }
);
watch(
  () => props.selectedEls,
  () => {
    elementsState.selected = props.selectedEls;
  }
);
watch(
  () => props.hide,
  () => {
    if (!props.hide) attachListeners();
    else detachListeners();
  },
  { immediate: true }
);

onBeforeUnmount(detachListeners);
</script>
