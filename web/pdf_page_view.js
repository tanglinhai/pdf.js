/* Copyright 2012 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  approximateFraction,
  CSS_UNITS,
  DEFAULT_SCALE,
  getOutputScale,
  NullL10n,
  RendererType,
  roundToDivide,
  TextLayerMode,
  // ------------------------------ tanglinhai start -------------------------------
  ScrollMode,
  SpreadMode
  // ------------------------------ tanglinhai end -------------------------------
} from "./ui_utils.js";
import {
  createPromiseCapability,
  RenderingCancelledException,
  SVGGraphics,
} from "pdfjs-lib";
import { RenderingStates } from "./pdf_rendering_queue.js";
import { viewerCompatibilityParams } from "./viewer_compatibility.js";

/**
 * @typedef {Object} PDFPageViewOptions
 * @property {HTMLDivElement} container - The viewer element.
 * @property {EventBus} eventBus - The application event bus.
 * @property {number} id - The page unique ID (normally its number).
 * @property {number} scale - The page scale display.
 * @property {PageViewport} defaultViewport - The page viewport.
 * @property {AnnotationStorage} [annotationStorage] - Storage for annotation
 *   data in forms. The default value is `null`.
 * @property {PDFRenderingQueue} renderingQueue - The rendering queue object.
 * @property {IPDFTextLayerFactory} textLayerFactory
 * @property {number} [textLayerMode] - Controls if the text layer used for
 *   selection and searching is created, and if the improved text selection
 *   behaviour is enabled. The constants from {TextLayerMode} should be used.
 *   The default value is `TextLayerMode.ENABLE`.
 * @property {IPDFAnnotationLayerFactory} annotationLayerFactory
 * @property {string} [imageResourcesPath] - Path for image resources, mainly
 *   for annotation icons. Include trailing slash.
 * @property {boolean} renderInteractiveForms - Turns on rendering of
 *   interactive form elements. The default is `false`.
 * @property {string} renderer - 'canvas' or 'svg'. The default is 'canvas'.
 * @property {boolean} [enableWebGL] - Enables WebGL accelerated rendering for
 *   some operations. The default value is `false`.
 * @property {boolean} [useOnlyCssZoom] - Enables CSS only zooming. The default
 *   value is `false`.
 * @property {number} [maxCanvasPixels] - The maximum supported canvas size in
 *   total pixels, i.e. width * height. Use -1 for no limit. The default value
 *   is 4096 * 4096 (16 mega-pixels).
 * @property {IL10n} l10n - Localization service.
 */

const MAX_CANVAS_PIXELS = viewerCompatibilityParams.maxCanvasPixels || 16777216;
/* ---------------------------------- tanglinhai start ------------------------------------ */
const PAGE_BORDER_SIZE = 9;
/* ---------------------------------- tanglinhai end ------------------------------------ */
/**
 * @implements {IRenderableView}
 */
class PDFPageView {
  /**
   * @param {PDFPageViewOptions} options
   */
  constructor(options) {
    const container = options.container;
    const defaultViewport = options.defaultViewport;

    this.id = options.id;
    this.renderingId = "page" + this.id;

    this.pdfPage = null;
    this.pageLabel = null;
    this.rotation = 0;
    this.scale = options.scale || DEFAULT_SCALE;
    this.viewport = defaultViewport;
    this._annotationStorage = options.annotationStorage || null;
    this.pdfPageRotate = defaultViewport.rotation;
    this.hasRestrictedScaling = false;
    this.textLayerMode = Number.isInteger(options.textLayerMode)
      ? options.textLayerMode
      : TextLayerMode.ENABLE;
    this.imageResourcesPath = options.imageResourcesPath || "";
    this.renderInteractiveForms = options.renderInteractiveForms || false;
    this.useOnlyCssZoom = options.useOnlyCssZoom || false;
    this.maxCanvasPixels = options.maxCanvasPixels || MAX_CANVAS_PIXELS;

    this.eventBus = options.eventBus;
    this.renderingQueue = options.renderingQueue;
    this.textLayerFactory = options.textLayerFactory;
    this.annotationLayerFactory = options.annotationLayerFactory;
    this.renderer = options.renderer || RendererType.CANVAS;
    this.enableWebGL = options.enableWebGL || false;
    this.l10n = options.l10n || NullL10n;

    this.paintTask = null;
    this.paintedViewportMap = new WeakMap();
    this.renderingState = RenderingStates.INITIAL;
    this.resume = null;
    this.error = null;

    this.annotationLayer = null;
    this.textLayer = null;
    this.zoomLayer = null;

    // ------------------------------ tanglinhai start -------------------------------
    let div = document.createElement('div');
    div.className = 'page';
    this.div = div;
    this.container = container;
    this.viewer = options.viewer;
    // flag of div is add to domtree or not.
    this.isDivAddedToContainer = false;
    // the page size position and spread size position
    this.position = {
      width: Math.floor(this.viewport.width) + PAGE_BORDER_SIZE * 2,
      height: Math.floor(this.viewport.height) + PAGE_BORDER_SIZE,
      row: 0,
      column: 0,
      top: 0,
      realTop: 0,
      left: 0,
      realLeft: 0,
      spread: this.getClonePositionSpreadObj(),
    };
    div.style.width = Math.floor(this.viewport.width) + 'px';
    div.style.height = Math.floor(this.viewport.height) + 'px';
    div.setAttribute('data-page-number', this.id);
    if (this.id === 1 || this.id === this.viewer.pdfDocument.numPages) {
      container.appendChild(div);
      this.isDivAddedToContainer = true;
      this.viewer._buffer.push(this);
    }

    /*const div = document.createElement("div");
    div.className = "page";
    div.style.width = Math.floor(this.viewport.width) + "px";
    div.style.height = Math.floor(this.viewport.height) + "px";
    div.setAttribute("data-page-number", this.id);
    this.div = div;*/
    // ------------------------------ tanglinhai end -------------------------------
  }
  /* ---------------------------------- tanglinhai start ------------------------------------ */
  /**
   * [getClonePositionSpreadObj in same spread dom use same obj]
   * @param  {[type]} spread [spread size position]
   * @return {[type]}        [the same spread or new spread]
   */
  getClonePositionSpreadObj(spread) {
    if (spread) {
      return {
          width: spread.width,
          height: spread.height,
          row: spread.row,
          column: spread.column,
          top: spread.top,
          realTop: spread.realTop,
          left: spread.left,
          realLeft: spread.realLeft,
        };
    }
    return {
      width: 0,
      height: 0,
      row: 0,
      column: 0,
      top: 0,
      realTop: 0,
      left: 0,
      realLeft: 0,
    };
  }

  /**
   * [setDivStyle set spreadNone spreadOdd spreadEven page position]
   * @param {[type]} pageView [page view obj]
   * @param {[type]} type     [is spread]
   */
  setDivStyle(pageView, type) {
    if (type !== 'spread') {
      let div = pageView.div;
      let cssStyle = pageView.position;
      div.style.left = cssStyle.realLeft + 'px';
      div.style.top = cssStyle.realTop + 'px';
    } else {
      let div = pageView.div.parentNode;
      if (div) {
        let cssStyle = pageView.position.spread;
        div.style.left = cssStyle.realLeft + 'px';
        div.style.top = cssStyle.realTop + 'px';
      }
    }
  }

  /**
   * [isVisible Is the current page visible]
   * @param {[pageId]} pageView [page view]
   * @return {Boolean} [Is it visible?]
   */
  isVisible(pageId) {
    let pId = pageId || this.id;
    let existNewList = false;
    let visiblePages = this.viewer.visiblePages.views;
    for (let j = 0; j < visiblePages.length; j++) {
      if (visiblePages[j].id === pId) {
        existNewList = true;
        break;
      }
    }
    return existNewList;
  }
  /* ---------------------------------- tanglinhai end ------------------------------------ */
  setPdfPage(pdfPage) {
    this.pdfPage = pdfPage;
    this.pdfPageRotate = pdfPage.rotate;

    const totalRotation = (this.rotation + this.pdfPageRotate) % 360;
    this.viewport = pdfPage.getViewport({
      scale: this.scale * CSS_UNITS,
      rotation: totalRotation,
    });
    // ------------------------------ tanglinhai start -------------------------------
    // When the total number of pages with size changes exceeds 300 and
    // the start time of the first page change exceeds 300 milliseconds,
    // the position is readjusted once.
    var chPaIdxs = this.viewer.sizeChangedStartTimePageIndexs;
    var newW = Math.floor(this.viewport.width) + PAGE_BORDER_SIZE * 2;
    var newH = Math.floor(this.viewport.height) + PAGE_BORDER_SIZE;
    var isWidthChange = false;
    var isHeightChange = false;
    if (newW !== this.position.width) {
      isWidthChange = true;
      this.position.width = newW;
    }
    if (newH !== this.position.height) {
      isHeightChange = true;
      this.position.height = newH;
    }
    if (isWidthChange || isHeightChange) {
      chPaIdxs.push(this.id - 1);
      if (!this.viewer.sizeChangedStartTime) {
        this.viewer.sizeChangedStartTime = new Date().getTime();
      }
    }
    /**
     * [if Satisfies the condition of updating page position]
     * 1. If it is the last page, all page locations are updated once.
     * Make sure the page position is correct
     * 2. If the current page is in the display area
     * 3. If the size change page exceeds 300 or the first size change
     * page now exceeds 300 milliseconds
     */
    const vpc = this.viewer.visiblePagesCache;
    let isReposition = false;
    if (chPaIdxs.length > 300 && (chPaIdxs.length > 0 ||
        new Date().getTime() - this.viewer.sizeChangedStartTime) > 300) {
      this.reposition(Math.min(chPaIdxs));
    } else if (vpc[vpc.length - 1].views && vpc[vpc.length - 1].views.findIndex(
                                      (vb) => vb.id === this.id) > -1) {
      this.reposition(this.id - 1);
    } else if (1 === this.viewer.getPagesLeft) {
      this.reposition(0);
      // Update thumbnail DOM when all pages are loaded.
      if (PDFViewerApplication.pdfSidebar.isThumbnailViewVisible) {
        PDFViewerApplication.pdfThumbnailViewer._scrollUpdated();
      }
    }
    if (isReposition) {
      this.viewer.sizeChangedStartTimePageIndexs = [];
      this.viewer.sizeChangedStartTime = 0;
    }
    // ------------------------------ tanglinhai end -------------------------------
    this.stats = pdfPage.stats;
    this.reset();
  }

  destroy() {
    /* ---------------------------------- tanglinhai start ------------------------------------ */
    // Not only page content scroll loading,
    // but also page container page div page scroll loading
    if (this.isDivAddedToContainer) {
      if (this._spreadMode === SpreadMode.NONE) {
        this.viewer.viewer.removeChild(this.div);
      } else {
        let spreadDiv = this.div.parentNode;
        if (spreadDiv.childNodes.length === 1) {
          this.viewer.viewer.removeChild(spreadDiv);
        } else {
          spreadDiv.removeChild(this.div);
        }
      }
    }
    this.isDivAddedToContainer = false;
    /* ---------------------------------- tanglinhai end ------------------------------------ */
    this.reset();
    if (this.pdfPage) {
      this.pdfPage.cleanup();
    }
  }

  /**
   * @private
   */
  async _renderAnnotationLayer() {
    let error = null;
    try {
      await this.annotationLayer.render(this.viewport, "display");
    } catch (ex) {
      error = ex;
    } finally {
      this.eventBus.dispatch("annotationlayerrendered", {
        source: this,
        pageNumber: this.id,
        error,
      });
    }
  }

  /**
   * @private
   */
  _resetZoomLayer(removeFromDOM = false) {
    // ----------------------------- tanglinhai start -----------------------------
    if (!this.zoomLayer || !this.zoomLayer.firstChild) {
    // ----------------------------- tanglinhai end -----------------------------
      return;
    }
    const zoomLayerCanvas = this.zoomLayer.firstChild;
    this.paintedViewportMap.delete(zoomLayerCanvas);
    // Zeroing the width and height causes Firefox to release graphics
    // resources immediately, which can greatly reduce memory consumption.
    zoomLayerCanvas.width = 0;
    zoomLayerCanvas.height = 0;

    if (removeFromDOM) {
      // Note: `ChildNode.remove` doesn't throw if the parent node is undefined.
      this.zoomLayer.remove();
    }
    this.zoomLayer = null;
  }
  /* ---------------------------------- tanglinhai start ------------------------------------ */
  /**
   * [adjustLastLineLeft Adjust the horizontal
   * middle style of the page on the previous line]
   * @param  {[type]} lastLineLastEleIdx [Index of the last
   * page in the previous row]
   * @param  {[type]} containerW         [Vessel width]
   * @param  {[type]} type               [spread type]
   */
  adjustLastLineLeft(lastLineLastEleIdx, containerW, type) {
    let pages = this.viewer._pages;
    let lastLineMaxW = 0;
    if (type === 'spread') {
      for (let j = lastLineLastEleIdx; j > -1; j -= 2) {
        lastLineMaxW += pages[j].position.spread.width - PAGE_BORDER_SIZE;
        if (pages[j].position.spread.column === 0) {
          break;
        }
      }
      lastLineMaxW += PAGE_BORDER_SIZE;
      let leftDiff = (containerW - lastLineMaxW) / 2;
      if (leftDiff > 0) {
        for (let j = lastLineLastEleIdx; j > -1; j -= 2) {
          pages[j].position.spread.realLeft =
                  pages[j].position.spread.left + leftDiff;
          if (pages[j].isDivAddedToContainer) {
            pages[j].div.parentNode.style.left =
                    pages[j].position.spread.realLeft + 'px';
          }
          if (pages[j].position.spread.column === 0) {
            break;
          }
        }

      }
    } else {
      for (let j = lastLineLastEleIdx; j > -1; j--) {
        lastLineMaxW += pages[j].position.width - PAGE_BORDER_SIZE;
        if (pages[j].position.column === 0) {
          break;
        }
      }
      lastLineMaxW += PAGE_BORDER_SIZE;
      let leftDiff = (containerW - lastLineMaxW) / 2;
      if (leftDiff > 0) {
        for (let j = lastLineLastEleIdx; j > -1; j--) {
          pages[j].position.realLeft = pages[j].position.left += leftDiff;
          pages[j].div.style.left = pages[j].position.realLeft + 'px';
          if (pages[j].position.column === 0) {
            break;
          }
        }
      }
    }
  }

  /**
   * [repositionAllPages reset all page position]
   */
  repositionAllPages() {
    this.reposition(0);
  }

/**
 * [isVtcSclBarShow Determine whether a scroll bar will appear
 * on the loading page, and if the calculated position appears,
 * the width or height of the scroll bar should be deducted.]
 * @return {Boolean}     [Whether scrollbars appear or not]
 */
isVtcSclBarShow(viewer, pages, pagesLen, containerH, pageBorderSize) {
  let currH = 0;
  // scrollWrapped
  if (viewer.scrollMode === ScrollMode.WRAPPED) {
    let lineMaxH = 0;
    let lineMaxW = 0;
    let lineItemCount = 0;
    // scrollWrapped + spreadNone
    const containerW = viewer.viewer.clientWidth;
    if (viewer.spreadMode === SpreadMode.NONE) {
      for (let i = 0; i < pagesLen; i++) {
        let page_ = pages[i];
        let pageW_ = page_.position.width - pageBorderSize;
        let pageH_ = page_.position.height;
        let lineMaxW_ = lineMaxW + pageW_;

        if (i > 0 && lineMaxW_ > containerW) { // a new line start
          lineMaxH = pageH_;
          lineMaxW = pageW_;
          lineItemCount = 1;
          currH += lineMaxH;
        } else { // in same line
          lineItemCount++;
          if (lineItemCount < 2) {
            lineMaxH = pageH_;
            currH += lineMaxH;
          } else {
            lineMaxH = Math.max(lineMaxH, pageH_);
          }
          lineMaxW = lineMaxW_;
        }
        if (currH > containerH) {
          return true;
        }
      }
    } else { // scrollWrapped + spreadOdd or spreadEven
      const parity = viewer.spreadMode % 2;
      for (let i = 0; i < pagesLen; ++i) {
        if (i % 2 === parity || i === pagesLen - 1) {
          let spreadMaxH;
          let spreadW;
          let page_ = pages[i];
          if (
              ((i === pagesLen - 1 && pagesLen > 1) &&
                ((viewer.spreadMode ===
                        SpreadMode.ODD && pagesLen % 2 === 0) ||
                (viewer.spreadMode ===
                        SpreadMode.EVEN && pagesLen % 2 === 1))) ||
              (i < pagesLen - 1 && i > 0)
            ) {
            spreadMaxH = Math.max(page_.position.height,
                      pages[i - 1].position.height);
            spreadW = page_.position.width + pages[i - 1].position.width
                                                        - pageBorderSize;
          } else {
            spreadMaxH = page_.position.height;
            spreadW = page_.position.width;
          }
          let lastSpreadIdxDiff = i % 2 !== parity ? 1 : 2;
          let lastSpreadView = pages[i - lastSpreadIdxDiff];
          let lineMaxW_ = lineMaxW + spreadW;
          if (lastSpreadView && lineMaxW_ > containerW) {
            lineMaxH = spreadMaxH;
            lineMaxW = spreadW;
            lineItemCount = 1;
            currH += lineMaxH;
          } else {
            lineItemCount++;
            if (lastSpreadView) {
              if (lineItemCount < 2) {
                lineMaxH = spreadMaxH;
                currH += lineMaxH;
              } else {
                lineMaxH = Math.max(lineMaxH, spreadMaxH);
              }
            }
            lineMaxW = lineMaxW_;
          }
          if (currH > containerH) {
            return true;
          }
        }
      }
    }
  } else if (viewer.scrollMode === ScrollMode.HORIZONTAL) {
    for (let i = 0; i < pagesLen; i++) {
      if (pages[i].position.height > containerH) {
        return true;
      }
    }
  } else if (viewer.spreadMode === SpreadMode.NONE) {
    // scrollVertical + spreadNone
    for (let i = 0; i < pagesLen; i++) {
      currH += pages[i].position.height;
      if (currH > containerH) {
        return true;
      }
    }
  } else {
    // scrollVertical + spreadOdd or spreadEven
    const parity = viewer.spreadMode % 2;
    for (let i = 0; i < pagesLen; i++) {
      if (i % 2 === parity) {
        currH += pages[i].position.height;
        if (currH > containerH) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * [reposition Relocate pages whose index is greater than pageIndex]
 * @param  {[type]} pageIdx [pageIndex]
 */
reposition(pageIdx) {
  const pageBorderSize = 9;
  const viewer = this.viewer;
  const SCROLL_BAR_SIZE = viewer.scrollBbarSize;
  let pages = viewer._pages;
  let pagesLen = pages.length;
  let pageIndex_ = pageIdx > -1 ? pageIdx : this.id - 1;
  let containerH = viewer.viewer.clientHeight;
  let containerW = viewer.viewer.offsetWidth -
    (this.isVtcSclBarShow(viewer, pages, pagesLen, containerH,
                pageBorderSize) ? SCROLL_BAR_SIZE.width : 0);
  // scrollWrapped
  if (viewer.scrollMode === ScrollMode.WRAPPED) {
    let lineMaxH = 0;
    let lineMaxW = 0;
    let lineItemCount = 0;
    // scrollWrapped + spreadNone
    if (viewer.spreadMode === SpreadMode.NONE) {
      let column0Idx = pageIndex_ - (pageIdx > -1 ?
            pages[pageIdx].position.column : this.position.column);
      for (let i = column0Idx; i < pagesLen; i++) {
        let page_ = pages[i];
        let lastPage_ = i === 0 ? null : pages[i - 1];
        let pageW_ = page_.position.width - pageBorderSize;
        let pageH_ = page_.position.height;
        let lineMaxW_ = lineMaxW + pageW_;
        // a new line start
        if (i > 0 && lineMaxW_ + pageBorderSize > containerW) {
          page_.position.row = lastPage_ ? lastPage_.position.row + 1 : 0;
          page_.position.column = 0;
          page_.position.realTop = page_.position.top =
                      lastPage_ ? lastPage_.position.top + lineMaxH : 0;
          page_.position.realLeft = page_.position.left = 0;
          lineMaxH = pageH_;
          lineMaxW = pageW_;
          lineItemCount = 1;
          column0Idx = i;

          this.adjustLastLineLeft(i - 1, containerW);
        } else { // in same line
          lineItemCount++;

          if (lastPage_) { // is the first page
            page_.position.row = lastPage_.position.row;
            page_.position.column = lineItemCount - 1;
            if (lineItemCount === 1) { // is the first column
              let lastLineMaxH = 0;
              for (let j = i - 1; j > -1; j--) {
                lastLineMaxH =
                Math.max(pages[j].position.height, lastLineMaxH);
                if (pages[j].position.column === 0) {
                  break;
                }
              }
              page_.position.realTop = page_.position.top =
                            lastPage_.position.top + lastLineMaxH;
              page_.position.realLeft = page_.position.left = 0;
            } else {
              page_.position.realTop = page_.position.top =
                                          lastPage_.position.top;
              page_.position.realLeft = page_.position.left =
              lastPage_.position.left + lastPage_.position.width - pageBorderSize;

              if (lineMaxH > page_.position.height) {
                page_.position.realTop = page_.position.top +
                                  (lineMaxH - page_.position.height) / 2;
              } else if (lineMaxH < page_.position.height) {
                for (let j = column0Idx; j < i; j++) {
                  if (pages[j].position.height < page_.position.height) {
                    pages[j].position.realTop = page_.position.top +
                    (page_.position.height - pages[j].position.height) / 2;
                  pages[j].div.style.top = pages[j].position.realTop + 'px';
                  }
                }
              }
            }
          } else {
            page_.position.row = 0;
            page_.position.column = 0;
            page_.position.realTop = page_.position.top = 0;
            page_.position.realLeft = page_.position.left = 0;
          }

          if (lineItemCount < 2) {
            lineMaxH = pageH_;
          } else {
            lineMaxH = Math.max(lineMaxH, pageH_);
          }
          lineMaxW = lineMaxW_;
        }
        this.setDivStyle(page_);
        if (page_.id === pagesLen) {
          this.adjustLastLineLeft(pagesLen - 1, containerW);
        }
      }
    } else { // scrollWrapped + spreadOdd or spreadEven
      const parity = viewer.spreadMode % 2;
      let lastSpreadIdxDiff = pageIndex_ % 2 !== parity ? 1 : 2;
      let lastSpreadView = viewer.spreadMode ===
      SpreadMode.ODD && pageIndex_ < 2 ||
        viewer.spreadMode === SpreadMode.EVEN && pageIndex_ < 1 ?
        null : pages[pageIndex_ - lastSpreadIdxDiff];

      let spreadColumn0Idx = !lastSpreadView ? (viewer.spreadMode ===
                                    SpreadMode.ODD ? 1 : 0) :
                pageIndex_ - lastSpreadView.position.spread.column * 2 -
                                    lastSpreadIdxDiff;
      /*spreadColumn0Idx = spreadColumn0Idx % 2 === parity ?
      spreadColumn0Idx : spreadColumn0Idx - 1;*/
      if (spreadColumn0Idx > -1) {
        let maxI = pageIndex_ - lastSpreadIdxDiff;
        for (let i = spreadColumn0Idx; i <= maxI; i += 2) {
          lineMaxW += pages[i].position.spread.width - pageBorderSize;
          lineMaxH = Math.max(lineMaxH, pages[i].position.spread.height);
          lineItemCount++;
        }
      } else {
        spreadColumn0Idx = 0;
      }
      for (let i = pageIndex_; i < pagesLen; ++i) {
        if (i % 2 === parity || i === pagesLen - 1) {
          let spreadMaxH;
          let spreadW;
          let page_ = pages[i];
          page_.position.spread =
                this.getClonePositionSpreadObj(page_.position.spread);
          if (
              ((i === pagesLen - 1 && pagesLen > 1) &&
                ((viewer.spreadMode ===
                        SpreadMode.ODD && pagesLen % 2 === 0) ||
                (viewer.spreadMode ===
                        SpreadMode.EVEN && pagesLen % 2 === 1))) ||
              (i < pagesLen - 1 && i > 0)
            ) {
            spreadMaxH = Math.max(page_.position.height,
                      pages[i - 1].position.height);
            spreadW = page_.position.width + pages[i - 1].position.width
                                                        - pageBorderSize;
          } else {
            spreadMaxH = page_.position.height;
            spreadW = page_.position.width;
          }
          page_.position.spread.width = spreadW;
          page_.position.spread.height = spreadMaxH;
          let lastSpreadIdxDiff = i % 2 !== parity ? 1 : 2;
          lastSpreadView = pages[i - lastSpreadIdxDiff];
          let lineMaxW_ = lineMaxW + spreadW;
          if (lastSpreadView && lineMaxW_ + pageBorderSize > containerW) {
            page_.position.spread.row =
                                lastSpreadView.position.spread.row + 1;
            page_.position.spread.column = 0;
            page_.position.spread.realTop = page_.position.spread.top =
                  lastSpreadView.position.spread.top + lineMaxH;
            page_.position.spread.realLeft = page_.position.spread.left = 0;

            lineMaxH = spreadMaxH;
            lineMaxW = spreadW;
            lineItemCount = 1;
            spreadColumn0Idx = i;
            this.adjustLastLineLeft(lastSpreadView.id - 1,
                                        containerW, 'spread');
          } else {
            lineItemCount++;
            if (lastSpreadView) {
              page_.position.spread.row = lastSpreadView.position.spread.row;
              page_.position.spread.column =
                                  lastSpreadView.position.spread.column + 1;
              page_.position.spread.realTop = page_.position.spread.top =
              lastSpreadView.position.spread.top;
              page_.position.spread.realLeft = page_.position.spread.left =
              lastSpreadView.position.spread.left +
                        lastSpreadView.position.spread.width - pageBorderSize;
              if (lineMaxH < page_.position.spread.height) {
                for (let j = spreadColumn0Idx; j <= i; j += 2) {
                  if (pages[j].position.spread.height <
                                              page_.position.spread.height) {
                    pages[j].position.spread.realTop =
                                              pages[j].position.spread.top +
                    (page_.position.spread.height -
                                        pages[j].position.spread.height) / 2;
                    if (pages[j].div.parentNode) {
                      pages[j].div.parentNode.style.top =
                                    pages[j].position.spread.realTop + 'px';
                    }
                  }
                }
              }
              if (lineItemCount < 2) {
                lineMaxH = spreadMaxH;
              } else {
                lineMaxH = Math.max(lineMaxH, spreadMaxH);
              }
              if (lineMaxH > page_.position.spread.height) {
                page_.position.spread.realTop = page_.position.spread.top +
                (lineMaxH - page_.position.spread.height) / 2;
              }
            } else {
              page_.position.spread.row = 0;
              page_.position.spread.column = 0;
              page_.position.spread.realTop = page_.position.spread.top = 0;
              page_.position.spread.realLeft =
                                            page_.position.spread.left = 0;
              lineMaxH = spreadMaxH;
            }
            lineMaxW = lineMaxW_;
          }
          if (i > 0 && lastSpreadIdxDiff === 2) {
            pages[i - 1].position.spread = page_.position.spread;
          }
          this.setDivStyle(page_, 'spread');
          if (page_.id === pagesLen) {
            this.adjustLastLineLeft(page_.id - 1, containerW, 'spread');
          }
        }
      }
    }
  } else if (viewer.scrollMode === ScrollMode.HORIZONTAL) {
    // scrollHorizontal + spreadNone
    if (viewer.spreadMode === SpreadMode.NONE) {
      for (let i = pageIndex_; i < pagesLen; i++) {
        let page_ = pages[i];
        if (i === 0) {
          page_.position.column = 0;
          page_.position.realLeft = page_.position.left = 0;
        } else {
          let lastView = pages[i - 1];
          page_.position.column = lastView.position.column + 1;
          page_.position.realLeft = page_.position.left =
          lastView.position.left + lastView.position.width - pageBorderSize;
        }
        page_.position.realTop = page_.position.top = containerH >
          page_.position.height + pageBorderSize ?
            (containerH - page_.position.height - pageBorderSize) / 2 : 0;
        this.setDivStyle(page_);
      }
    } else {
      // scrollHorizontal + spreadOdd or spreadEven
      const parity = viewer.spreadMode % 2;
      for (let i = pageIndex_; i < pagesLen; ++i) {
        let page_ = pages[i];
        let spreadMaxH;
        let spreadW;
        if (i % 2 === parity || i === pagesLen - 1) {
          page_.position.spread =
              this.getClonePositionSpreadObj(page_.position.spread);
          if (
                ((i === pagesLen && pagesLen > 1) &&
                  ((viewer.spreadMode ===
                            SpreadMode.ODD && pagesLen % 2 === 0) ||
                  (viewer.spreadMode ===
                            SpreadMode.EVEN && pagesLen % 2 === 1))) ||
                (i < pagesLen - 1 && i > 0)
              ) {
            spreadMaxH = Math.max(page_.position.height,
                                          pages[i - 1].position.height);
            spreadW = page_.position.width + pages[i - 1].position.width
                                      - pageBorderSize;

            pages[i - 1].position.spread.width = spreadW;
            pages[i - 1].position.spread.height = spreadMaxH;
          } else {
            spreadMaxH = page_.position.height;
            spreadW = page_.position.width;
          }
          page_.position.spread.width = spreadW;
          page_.position.spread.height = spreadMaxH;

          if (pagesLen === 1 || viewer.spreadMode ===
                                          SpreadMode.ODD && i === 1 ||
              viewer.spreadMode === SpreadMode.EVEN && i === 0) {
            page_.position.spread.column = 0;
            page_.position.spread.realLeft = page_.position.spread.left = 0;
            if (viewer.spreadMode === SpreadMode.ODD && i === 1) {
              pages[0].position.spread = page_.position.spread;
            }
          } else {
            let lastSpreadIdxDiff = i % 2 !== parity ? 1 : 2;
            let lastSpreadView = pages[i - lastSpreadIdxDiff];
            page_.position.spread.column =
                            lastSpreadView.position.spread.column + 1;
            page_.position.spread.realLeft = page_.position.spread.left =
            lastSpreadView.position.spread.left +
                     lastSpreadView.position.spread.width - pageBorderSize;
            if (i > 0 && lastSpreadIdxDiff === 2) {
              pages[i - 1].position.spread = page_.position.spread;
            }
          }
          page_.position.spread.realTop = page_.position.spread.top =
          containerH > page_.position.spread.height + pageBorderSize ?
    (containerH - page_.position.spread.height - pageBorderSize) / 2 : 0;
          this.setDivStyle(page_, 'spread');
        }
      }
    }
  } else if (viewer.spreadMode === SpreadMode.NONE) {
    // scrollVertical + spreadNone
    for (let i = pageIndex_; i < pagesLen; i++) {
      let page_ = pages[i];
      if (i === 0) {
        page_.position.row = 0;
        page_.position.realTop = page_.position.top = 0;
      } else {
        let lastView = pages[i - 1];
        page_.position.row = lastView.position.row + 1;
        page_.position.realTop = page_.position.top =
        lastView.position.top + lastView.position.height;
      }
      page_.position.realLeft = page_.position.left = containerW >
      page_.position.width ? (containerW - page_.position.width) / 2 : 0;
      this.setDivStyle(page_);
    }
  } else {
    // scrollVertical + spreadOdd or spreadEven
    const parity = viewer.spreadMode % 2;
    for (let i = pageIndex_; i < pagesLen; ++i) {
      let page_ = pages[i];
      let spreadMaxH;
      let spreadW;
      if (i % 2 === parity || i === pagesLen - 1) {
        page_.position.spread =
                    this.getClonePositionSpreadObj(page_.position.spread);
        if (
              ((i === pagesLen - 1 && pagesLen > 1) &&
                ((viewer.spreadMode ===
                    SpreadMode.ODD && pagesLen % 2 === 0) ||
                (viewer.spreadMode ===
                    SpreadMode.EVEN && pagesLen % 2 === 1))) ||
              (i < pagesLen - 1 && i > 0)
            ) {
          spreadMaxH = Math.max(page_.position.height,
                        pages[i - 1].position.height);
          spreadW = page_.position.width + pages[i - 1].position.width
                                                         - pageBorderSize;
        } else {
          spreadMaxH = page_.position.height;
          spreadW = page_.position.width;
        }
        page_.position.spread.width = spreadW;
        page_.position.spread.height = spreadMaxH;

        if (pagesLen === 1 || viewer.spreadMode ===
                            SpreadMode.ODD && i === 1 ||
            viewer.spreadMode === SpreadMode.EVEN && i === 0) {
          page_.position.spread.row = 0;
          page_.position.spread.realTop = page_.position.spread.top = 0;
          if (viewer.spreadMode === SpreadMode.ODD && i === 1) {
            pages[0].position.spread = page_.position.spread;
          }
        } else {
          let lastSpreadIdxDiff = i % 2 !== parity ? 1 : 2;
          let lastSpreadView = pages[i - lastSpreadIdxDiff];
          page_.position.spread.row = lastSpreadView.position.spread.row + 1;
          page_.position.spread.realTop = page_.position.spread.top =
          lastSpreadView.position.spread.top +
                                    lastSpreadView.position.spread.height;
          if (i > 0 && lastSpreadIdxDiff === 2) {
            pages[i - 1].position.spread = page_.position.spread;
          }
        }
        page_.position.spread.realLeft = page_.position.spread.left =
        containerW > page_.position.spread.width ?
                    (containerW - page_.position.spread.width) / 2 : 0;
        this.setDivStyle(page_, 'spread');
      }
    }
  }
  viewer._resetCurrentPageView();
}
/* ---------------------------------- tanglinhai end ------------------------------------ */
  reset(keepZoomLayer = false, keepAnnotations = false) {
    this.cancelRendering(keepAnnotations);
    this.renderingState = RenderingStates.INITIAL;


    const div = this.div;
    // ------------------------------ tanglinhai start -------------------------------
    let newW = Math.floor(this.viewport.width);
    let newH = Math.floor(this.viewport.height);
    if (parseInt(div.style.width) !== newW) {
      div.style.width = newW + 'px';
    }
    if (parseInt(div.style.height) !== newH) {
      div.style.height = newH + 'px';
    }

    this.position.width = newW + PAGE_BORDER_SIZE * 2;
    this.position.height = newH + PAGE_BORDER_SIZE;

    /*div.style.width = Math.floor(this.viewport.width) + "px";
    div.style.height = Math.floor(this.viewport.height) + "px";*/
    // ------------------------------ tanglinhai end -------------------------------

    const childNodes = div.childNodes;
    const currentZoomLayerNode = (keepZoomLayer && this.zoomLayer) || null;
    const currentAnnotationNode =
      (keepAnnotations && this.annotationLayer && this.annotationLayer.div) ||
      null;
    for (let i = childNodes.length - 1; i >= 0; i--) {
      const node = childNodes[i];
      if (currentZoomLayerNode === node || currentAnnotationNode === node) {
        continue;
      }
      div.removeChild(node);
    }
    div.removeAttribute("data-loaded");

    if (currentAnnotationNode) {
      // Hide the annotation layer until all elements are resized
      // so they are not displayed on the already resized page.
      this.annotationLayer.hide();
    } else if (this.annotationLayer) {
      this.annotationLayer.cancel();
      this.annotationLayer = null;
    }

    if (!currentZoomLayerNode) {
      if (this.canvas) {
        this.paintedViewportMap.delete(this.canvas);
        // Zeroing the width and height causes Firefox to release graphics
        // resources immediately, which can greatly reduce memory consumption.
        this.canvas.width = 0;
        this.canvas.height = 0;
        delete this.canvas;
      }
      this._resetZoomLayer();
    }
    if (this.svg) {
      this.paintedViewportMap.delete(this.svg);
      delete this.svg;
    }

    this.loadingIconDiv = document.createElement("div");
    this.loadingIconDiv.className = "loadingIcon";
    div.appendChild(this.loadingIconDiv);
  }

  update(scale, rotation) {
    this.scale = scale || this.scale;
    // The rotation may be zero.
    if (typeof rotation !== "undefined") {
      this.rotation = rotation;
    }

    const totalRotation = (this.rotation + this.pdfPageRotate) % 360;
    this.viewport = this.viewport.clone({
      scale: this.scale * CSS_UNITS,
      rotation: totalRotation,
    });

    if (this.svg) {
      this.cssTransform(this.svg, true);

      this.eventBus.dispatch("pagerendered", {
        source: this,
        pageNumber: this.id,
        cssTransform: true,
        timestamp: performance.now(),
      });
      return;
    }

    let isScalingRestricted = false;
    if (this.canvas && this.maxCanvasPixels > 0) {
      const outputScale = this.outputScale;
      if (
        ((Math.floor(this.viewport.width) * outputScale.sx) | 0) *
          ((Math.floor(this.viewport.height) * outputScale.sy) | 0) >
        this.maxCanvasPixels
      ) {
        isScalingRestricted = true;
      }
    }

    if (this.canvas) {
      if (
        this.useOnlyCssZoom ||
        (this.hasRestrictedScaling && isScalingRestricted)
      ) {
        this.cssTransform(this.canvas, true);

        this.eventBus.dispatch("pagerendered", {
          source: this,
          pageNumber: this.id,
          cssTransform: true,
          timestamp: performance.now(),
        });
        return;
      }
      if (!this.zoomLayer && !this.canvas.hasAttribute("hidden")) {
        this.zoomLayer = this.canvas.parentNode;
        this.zoomLayer.style.position = "absolute";
      }
    }
    // -------------------------- tanglinhai start -----------------------------
    if (this.zoomLayer && this.zoomLayer.firstChild) {
    // -------------------------- tanglinhai end -----------------------------
      this.cssTransform(this.zoomLayer.firstChild);
    }
    this.reset(/* keepZoomLayer = */ true, /* keepAnnotations = */ true);
  }

  /**
   * PLEASE NOTE: Most likely you want to use the `this.reset()` method,
   *              rather than calling this one directly.
   */
  cancelRendering(keepAnnotations = false) {
    if (this.paintTask) {
      this.paintTask.cancel();
      this.paintTask = null;
    }
    this.resume = null;

    if (this.textLayer) {
      this.textLayer.cancel();
      this.textLayer = null;
    }
    if (!keepAnnotations && this.annotationLayer) {
      this.annotationLayer.cancel();
      this.annotationLayer = null;
    }
  }

  cssTransform(target, redrawAnnotations = false) {
    // Scale target (canvas or svg), its wrapper and page container.
    const width = this.viewport.width;
    const height = this.viewport.height;
    const div = this.div;
    target.style.width = target.parentNode.style.width = div.style.width =
      Math.floor(width) + "px";
    target.style.height = target.parentNode.style.height = div.style.height =
      Math.floor(height) + "px";
    // The canvas may have been originally rotated; rotate relative to that.
    const relativeRotation =
      this.viewport.rotation - this.paintedViewportMap.get(target).rotation;
    const absRotation = Math.abs(relativeRotation);
    let scaleX = 1,
      scaleY = 1;
    if (absRotation === 90 || absRotation === 270) {
      // Scale x and y because of the rotation.
      scaleX = height / width;
      scaleY = width / height;
    }
    const cssTransform =
      "rotate(" +
      relativeRotation +
      "deg) " +
      "scale(" +
      scaleX +
      "," +
      scaleY +
      ")";
    target.style.transform = cssTransform;

    if (this.textLayer) {
      // Rotating the text layer is more complicated since the divs inside the
      // the text layer are rotated.
      // TODO: This could probably be simplified by drawing the text layer in
      // one orientation and then rotating overall.
      const textLayerViewport = this.textLayer.viewport;
      const textRelativeRotation =
        this.viewport.rotation - textLayerViewport.rotation;
      const textAbsRotation = Math.abs(textRelativeRotation);
      let scale = width / textLayerViewport.width;
      if (textAbsRotation === 90 || textAbsRotation === 270) {
        scale = width / textLayerViewport.height;
      }
      const textLayerDiv = this.textLayer.textLayerDiv;
      let transX, transY;
      switch (textAbsRotation) {
        case 0:
          transX = transY = 0;
          break;
        case 90:
          transX = 0;
          transY = "-" + textLayerDiv.style.height;
          break;
        case 180:
          transX = "-" + textLayerDiv.style.width;
          transY = "-" + textLayerDiv.style.height;
          break;
        case 270:
          transX = "-" + textLayerDiv.style.width;
          transY = 0;
          break;
        default:
          console.error("Bad rotation value.");
          break;
      }

      textLayerDiv.style.transform =
        "rotate(" +
        textAbsRotation +
        "deg) " +
        "scale(" +
        scale +
        ", " +
        scale +
        ") " +
        "translate(" +
        transX +
        ", " +
        transY +
        ")";
      textLayerDiv.style.transformOrigin = "0% 0%";
    }

    if (redrawAnnotations && this.annotationLayer) {
      this._renderAnnotationLayer();
    }
  }

  get width() {
    return this.viewport.width;
  }

  get height() {
    return this.viewport.height;
  }

  getPagePoint(x, y) {
    return this.viewport.convertToPdfPoint(x, y);
  }

  draw() {
    if (this.renderingState !== RenderingStates.INITIAL) {
      console.error("Must be in new state before drawing");
      this.reset(); // Ensure that we reset all state to prevent issues.
    }
    const { div, pdfPage } = this;

    if (!pdfPage) {
      this.renderingState = RenderingStates.FINISHED;

      if (this.loadingIconDiv) {
        div.removeChild(this.loadingIconDiv);
        delete this.loadingIconDiv;
      }
      return Promise.reject(new Error("pdfPage is not loaded"));
    }

    this.renderingState = RenderingStates.RUNNING;
    /* ---------------------------------- tanglinhai start ------------------------------------ */
    /*function insertRule(styleElement, rule) {
      const styleSheet = styleElement.sheet;
      styleSheet.insertRule(rule, styleSheet.cssRules.length);
    }*/
    var isIE = !!window.ActiveXObject || "ActiveXObject" in window;
    var fragment;
    if(isIE){
      this.loadingIconDiv = document.createElement("div");
      this.loadingIconDiv.className = "loadingIcon";
      div.innerHTML = '';
      div.appendChild(this.loadingIconDiv);
      fragment = div;
    }else{
      fragment = document.createElement("div");

      /*var styleElement = document.createElement("style")
      fragment.appendChild(styleElement);*/
    }
    /* ---------------------------------- tanglinhai end ------------------------------------ */

    let canvasWrapper;
    /* ---------------------------------- tanglinhai start ------------------------------------ */
    // if(!fragment.querySelector('.canvasWrapper')){
      // Wrap the canvas so that if it has a CSS transform for high DPI the
      // overflow will be hidden in Firefox.
      canvasWrapper = document.createElement("div");
      canvasWrapper.style.width = div.style.width;
      canvasWrapper.style.height = div.style.height;
      canvasWrapper.classList.add("canvasWrapper");
      fragment.appendChild(canvasWrapper);
    // }
    /* ---------------------------------- tanglinhai end ------------------------------------ */
    
    /* ---------------------------------- tanglinhai start ------------------------------------ */
    if (this.annotationLayer && this.annotationLayer.div) {
      // The annotation layer needs to stay on top.
      // fragment.insertBefore(canvasWrapper, this.annotationLayer.div);
      fragment.appendChild(canvasWrapper);
      fragment.appendChild(this.annotationLayer.div);
    } else {
      // fragment.appendChild(canvasWrapper);
    }
    /* ---------------------------------- tanglinhai end ------------------------------------ */

    let textLayer = null;
    let textLayerDiv;
    if (this.textLayerMode !== TextLayerMode.DISABLE && this.textLayerFactory) {
      /* ---------------------------------- tanglinhai start ------------------------------------ */
      // if(!fragment.querySelector('.textLayer')){
        textLayerDiv = document.createElement("div");
        textLayerDiv.className = "textLayer";
        textLayerDiv.style.width = canvasWrapper.style.width;
        textLayerDiv.style.height = canvasWrapper.style.height;
      // }
      if (this.annotationLayer && this.annotationLayer.div) {
        // The annotation layer needs to stay on top.
        fragment.insertBefore(textLayerDiv, this.annotationLayer.div);
      } else {
        fragment.appendChild(textLayerDiv);
      }
      /* ---------------------------------- tanglinhai end ------------------------------------ */

      textLayer = this.textLayerFactory.createTextLayerBuilder(
        textLayerDiv,
        this.id - 1,
        this.viewport,
        this.textLayerMode === TextLayerMode.ENABLE_ENHANCE,
        this.eventBus
      );
    }
    this.textLayer = textLayer;

    let renderContinueCallback = null;
    if (this.renderingQueue) {
      renderContinueCallback = cont => {
        if (!this.renderingQueue.isHighestPriority(this)) {
          this.renderingState = RenderingStates.PAUSED;
          this.resume = () => {
            this.renderingState = RenderingStates.RUNNING;
            cont();
          };
          return;
        }
        cont();
      };
    }

    const finishPaintTask = async error => {
      // The paintTask may have been replaced by a new one, so only remove
      // the reference to the paintTask if it matches the one that is
      // triggering this callback.
      if (paintTask === this.paintTask) {
        this.paintTask = null;
      }

      if (error instanceof RenderingCancelledException) {
        this.error = null;
        return;
      }
      this.renderingState = RenderingStates.FINISHED;

      /* ---------------------------------- tanglinhai start ------------------------------------ */
      // this.viewer.renderingCache.splice(this.viewer.renderingCache.indexOf(this), 1);
      if (this.loadingIconDiv) {
        isIE && div.removeChild(this.loadingIconDiv);
        delete this.loadingIconDiv;
      }
      if(!isIE){
        div.innerHTML = '';
        div.appendChild(fragment);
      }
      /* ---------------------------------- tanglinhai end ------------------------------------ */
      this._resetZoomLayer(/* removeFromDOM = */ true);

      this.error = error;
      this.stats = pdfPage.stats;

      this.eventBus.dispatch("pagerendered", {
        source: this,
        pageNumber: this.id,
        cssTransform: false,
        timestamp: performance.now(),
      });

      if (error) {
        throw error;
      }
    };

    const paintTask =
      this.renderer === RendererType.SVG
        ? this.paintOnSvg(canvasWrapper)
        : this.paintOnCanvas(canvasWrapper);
    paintTask.onRenderContinue = renderContinueCallback;
    this.paintTask = paintTask;

    const resultPromise = paintTask.promise.then(
      function () {
        return finishPaintTask(null).then(function () {
          if (textLayer) {
            const readableStream = pdfPage.streamTextContent({
              normalizeWhitespace: true,
            });
            textLayer.setTextContentStream(readableStream);
            textLayer.render();
          }
        });
      },
      function (reason) {
        return finishPaintTask(reason);
      }
    );

    if (this.annotationLayerFactory) {
      if (!this.annotationLayer) {
        this.annotationLayer = this.annotationLayerFactory.createAnnotationLayerBuilder(
          div,
          pdfPage,
          this._annotationStorage,
          this.imageResourcesPath,
          this.renderInteractiveForms,
          this.l10n
        );
      }
      this._renderAnnotationLayer();
    }
    div.setAttribute("data-loaded", true);

    this.eventBus.dispatch("pagerender", {
      source: this,
      pageNumber: this.id,
    });
    return resultPromise;
  }

  paintOnCanvas(canvasWrapper) {
    const renderCapability = createPromiseCapability();
    const result = {
      promise: renderCapability.promise,
      onRenderContinue(cont) {
        cont();
      },
      cancel() {
        renderTask.cancel();
      },
    };

    const viewport = this.viewport;
    const canvas = document.createElement("canvas");
    this.l10n
      .get("page_canvas", { page: this.id }, "Page {{page}}")
      .then(msg => {
        canvas.setAttribute("aria-label", msg);
      });

    // Keep the canvas hidden until the first draw callback, or until drawing
    // is complete when `!this.renderingQueue`, to prevent black flickering.
    // ----------------------- tanglinhai test start ------------------------------
    // canvas.setAttribute("hidden", "hidden");
    let isCanvasHidden = false;
    // ----------------------- tanglinhai test end ------------------------------
    const showCanvas = function () {
      if (isCanvasHidden) {
        canvas.removeAttribute("hidden");
        isCanvasHidden = false;
      }
    };

    canvasWrapper.appendChild(canvas);
    this.canvas = canvas;

    if (
      typeof PDFJSDev === "undefined" ||
      PDFJSDev.test("MOZCENTRAL || GENERIC")
    ) {
      canvas.mozOpaque = true;
    }

    const ctx = canvas.getContext("2d", { alpha: false });
    const outputScale = getOutputScale(ctx);
    this.outputScale = outputScale;

    if (this.useOnlyCssZoom) {
      const actualSizeViewport = viewport.clone({ scale: CSS_UNITS });
      // Use a scale that makes the canvas have the originally intended size
      // of the page.
      outputScale.sx *= actualSizeViewport.width / viewport.width;
      outputScale.sy *= actualSizeViewport.height / viewport.height;
      outputScale.scaled = true;
    }

    if (this.maxCanvasPixels > 0) {
      const pixelsInViewport = viewport.width * viewport.height;
      const maxScale = Math.sqrt(this.maxCanvasPixels / pixelsInViewport);
      if (outputScale.sx > maxScale || outputScale.sy > maxScale) {
        outputScale.sx = maxScale;
        outputScale.sy = maxScale;
        outputScale.scaled = true;
        this.hasRestrictedScaling = true;
      } else {
        this.hasRestrictedScaling = false;
      }
    }

    const sfx = approximateFraction(outputScale.sx);
    const sfy = approximateFraction(outputScale.sy);
    canvas.width = roundToDivide(viewport.width * outputScale.sx, sfx[0]);
    canvas.height = roundToDivide(viewport.height * outputScale.sy, sfy[0]);
    canvas.style.width = roundToDivide(viewport.width, sfx[1]) + "px";
    canvas.style.height = roundToDivide(viewport.height, sfy[1]) + "px";
    // Add the viewport so it's known what it was originally drawn with.
    this.paintedViewportMap.set(canvas, viewport);

    // Rendering area
    const transform = !outputScale.scaled
      ? null
      : [outputScale.sx, 0, 0, outputScale.sy, 0, 0];
    const renderContext = {
      canvasContext: ctx,
      transform,
      viewport: this.viewport,
      enableWebGL: this.enableWebGL,
      renderInteractiveForms: this.renderInteractiveForms,
    };
    const renderTask = this.pdfPage.render(renderContext);
    renderTask.onContinue = function (cont) {
      showCanvas();
      if (result.onRenderContinue) {
        result.onRenderContinue(cont);
      } else {
        cont();
      }
    };

    renderTask.promise.then(
      function () {
        showCanvas();
        renderCapability.resolve(undefined);
      },
      function (error) {
        showCanvas();
        renderCapability.reject(error);
      }
    );
    return result;
  }

  paintOnSvg(wrapper) {
    if (
      typeof PDFJSDev !== "undefined" &&
      PDFJSDev.test("MOZCENTRAL || CHROME")
    ) {
      // Return a mock object, to prevent errors such as e.g.
      // "TypeError: paintTask.promise is undefined".
      return {
        promise: Promise.reject(new Error("SVG rendering is not supported.")),
        onRenderContinue(cont) {},
        cancel() {},
      };
    }

    let cancelled = false;
    const ensureNotCancelled = () => {
      if (cancelled) {
        throw new RenderingCancelledException(
          `Rendering cancelled, page ${this.id}`,
          "svg"
        );
      }
    };

    const pdfPage = this.pdfPage;
    const actualSizeViewport = this.viewport.clone({ scale: CSS_UNITS });
    const promise = pdfPage.getOperatorList().then(opList => {
      ensureNotCancelled();
      const svgGfx = new SVGGraphics(pdfPage.commonObjs, pdfPage.objs);
      return svgGfx.getSVG(opList, actualSizeViewport).then(svg => {
        ensureNotCancelled();
        this.svg = svg;
        this.paintedViewportMap.set(svg, actualSizeViewport);

        svg.style.width = wrapper.style.width;
        svg.style.height = wrapper.style.height;
        this.renderingState = RenderingStates.FINISHED;
        wrapper.appendChild(svg);
      });
    });

    return {
      promise,
      onRenderContinue(cont) {
        cont();
      },
      cancel() {
        cancelled = true;
      },
    };
  }

  /**
   * @param {string|null} label
   */
  setPageLabel(label) {
    this.pageLabel = typeof label === "string" ? label : null;

    if (this.pageLabel !== null) {
      this.div.setAttribute("data-page-label", this.pageLabel);
    } else {
      this.div.removeAttribute("data-page-label");
    }
  }
}

export { PDFPageView };
