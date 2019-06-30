/* Copyright 2014 Mozilla Foundation
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
  CSS_UNITS, DEFAULT_SCALE, DEFAULT_SCALE_VALUE, getGlobalEventBus,
  getOffsetLeft, getOffsetTop, isPortraitOrientation, isValidRotation,
  isValidScrollMode, isValidSpreadMode, MAX_AUTO_SCALE, moveToEndOfArray,
  NullL10n, PresentationModeState, RendererType, SCROLLBAR_PADDING,
  scrollIntoView, ScrollMode, SpreadMode, TextLayerMode, UNKNOWN_SCALE,
  util_getVisibleElements, util_scrollIntoView, VERTICAL_PADDING, watchScroll
} from './ui_utils';
import { PDFRenderingQueue, RenderingStates } from './pdf_rendering_queue';
import { AnnotationLayerBuilder } from './annotation_layer_builder';
import { createPromiseCapability } from 'pdfjs-lib';
import { PDFPageView } from './pdf_page_view';
import { SimpleLinkService } from './pdf_link_service';
import { TextLayerBuilder } from './text_layer_builder';

const DEFAULT_CACHE_SIZE = 10;

/**
 * @typedef {Object} PDFViewerOptions
 * @property {HTMLDivElement} container - The container for the viewer element.
 * @property {HTMLDivElement} viewer - (optional) The viewer element.
 * @property {EventBus} eventBus - The application event bus.
 * @property {IPDFLinkService} linkService - The navigation/linking service.
 * @property {DownloadManager} downloadManager - (optional) The download
 *   manager component.
 * @property {PDFFindController} findController - (optional) The find
 *   controller component.
 * @property {PDFRenderingQueue} renderingQueue - (optional) The rendering
 *   queue object.
 * @property {boolean} removePageBorders - (optional) Removes the border shadow
 *   around the pages. The default value is `false`.
 * @property {number} textLayerMode - (optional) Controls if the text layer used
 *   for selection and searching is created, and if the improved text selection
 *   behaviour is enabled. The constants from {TextLayerMode} should be used.
 *   The default value is `TextLayerMode.ENABLE`.
 * @property {string} imageResourcesPath - (optional) Path for image resources,
 *   mainly for annotation icons. Include trailing slash.
 * @property {boolean} renderInteractiveForms - (optional) Enables rendering of
 *   interactive form elements. The default is `false`.
 * @property {boolean} enablePrintAutoRotate - (optional) Enables automatic
 *   rotation of pages whose orientation differ from the first page upon
 *   printing. The default is `false`.
 * @property {string} renderer - 'canvas' or 'svg'. The default is 'canvas'.
 * @property {boolean} enableWebGL - (optional) Enables WebGL accelerated
 *   rendering for some operations. The default value is `false`.
 * @property {boolean} useOnlyCssZoom - (optional) Enables CSS only zooming.
 *   The default value is `false`.
 * @property {number} maxCanvasPixels - (optional) The maximum supported canvas
 *   size in total pixels, i.e. width * height. Use -1 for no limit.
 *   The default value is 4096 * 4096 (16 mega-pixels).
 * @property {IL10n} l10n - Localization service.
 */

function PDFPageViewBuffer(size, viewer) {
  let data = [];
  this.push = function(view) {
    let i = data.indexOf(view);
    if (i >= 0) {
      data.splice(i, 1);
    }
    data.push(view);
    this.delSomeData(1);
  };
  /**
   * [delSomeData Do not delete the first and last pages to
   * determine the height of the container]
   * @param  {[type]} type [Make a distinction between
   * adding a page or resize]
   */
  this.delSomeData = function(type) {
    let pagesCount = viewer.pdfDocument.numPages;
    if (data.length > size) {
      for (let i = 0; i < data.length; i++) {
        if (data[i].id !== 1 && data[i].id !== pagesCount) {
          data.splice(i, 1)[0].destroy();
	  // add one page to buffer, then just delete the one and exit.
          if (type === 1) {
            break;
          }
        }
        if (data.length === size) {
          break;
        }
      }
    }
  };
  /**
   * After calling resize, the size of the buffer will be newSize. The optional
   * parameter pagesToKeep is, if present, an array of pages to push to the back
   * of the buffer, delaying their destruction. The size of pagesToKeep has no
   * impact on the final size of the buffer; if pagesToKeep has length larger
   * than newSize, some of those pages will be destroyed anyway.
   */
  this.resize = function(newSize, pagesToKeep) {
    size = newSize;
    if (pagesToKeep) {
      const pageIdsToKeep = new Set();
      for (let i = 0, iMax = pagesToKeep.length; i < iMax; ++i) {
        pageIdsToKeep.add(pagesToKeep[i].id);
      }
      moveToEndOfArray(data, function(page) {
        return pageIdsToKeep.has(page.id);
      });
    }
    this.delSomeData();
  };
}

function isSameScale(oldScale, newScale) {
  if (newScale === oldScale) {
    return true;
  }
  if (Math.abs(newScale - oldScale) < 1e-15) {
    // Prevent unnecessary re-rendering of all pages when the scale
    // changes only because of limited numerical precision.
    return true;
  }
  return false;
}

/**
 * Simple viewer control to display PDF content/pages.
 * @implements {IRenderableView}
 */
class BaseViewer {
  /**
   * @param {PDFViewerOptions} options
   */
  constructor(options) {
    if (this.constructor === BaseViewer) {
      throw new Error('Cannot initialize BaseViewer.');
    }
    this._name = this.constructor.name;

    this.container = options.container;
    this.containerW = options.container.clientWidth;
    // When a page is loaded in batches and the size of the page changes,
    // the index of the page whose size changes is stored in the array is
    // convenient to adjust the position of these pages later.
    this.sizeChangedStartTimePageIndexs = [];
    this.sizeChangedStartTime = 0;
    // Page caching in rendering to control the operation of canceling
    // rendering while rendering in a non-display area
    this.renderingCache = [];
    // Save the visual pages to compare whether the pages currently rendered
    // and to be rendered are visible.
    this.visiblePages = null;
    this.viewer = options.viewer || options.container.firstElementChild;
    this.eventBus = options.eventBus || getGlobalEventBus();
    this.linkService = options.linkService || new SimpleLinkService();
    this.downloadManager = options.downloadManager || null;
    this.findController = options.findController || null;
    this.removePageBorders = options.removePageBorders || false;
    this.textLayerMode = Number.isInteger(options.textLayerMode) ?
      options.textLayerMode : TextLayerMode.ENABLE;
    this.imageResourcesPath = options.imageResourcesPath || '';
    this.renderInteractiveForms = options.renderInteractiveForms || false;
    this.enablePrintAutoRotate = options.enablePrintAutoRotate || false;
    this.renderer = options.renderer || RendererType.CANVAS;
    this.enableWebGL = options.enableWebGL || false;
    this.useOnlyCssZoom = options.useOnlyCssZoom || false;
    this.maxCanvasPixels = options.maxCanvasPixels;
    this.l10n = options.l10n || NullL10n;

    this.defaultRenderingQueue = !options.renderingQueue;
    if (this.defaultRenderingQueue) {
      // Custom rendering queue is not specified, using default one
      this.renderingQueue = new PDFRenderingQueue();
      this.renderingQueue.setViewer(this);
    } else {
      this.renderingQueue = options.renderingQueue;
    }

    this.scroll = watchScroll(this.viewer, this._scrollUpdate.bind(this));
    this.presentationModeState = PresentationModeState.UNKNOWN;
    this._resetView();

    if (this.removePageBorders) {
      this.viewer.classList.add('removePageBorders');
    }
    // Defer the dispatching of this event, to give other viewer components
    // time to initialize *and* register 'baseviewerinit' event listeners.
    Promise.resolve().then(() => {
      this.eventBus.dispatch('baseviewerinit', { source: this, });
    });
  }

  get pagesCount() {
    return this._pages.length;
  }

  getPageView(index) {
    return this._pages[index];
  }

  /**
   * @returns {boolean} true if all {PDFPageView} objects are initialized.
   */
  get pageViewsReady() {
    return this._pageViewsReady;
  }

  /**
   * @returns {number}
   */
  get currentPageNumber() {
    return this._currentPageNumber;
  }

  /**
   * @param {number} val - The page number.
   */
  set currentPageNumber(val) {
    if (!Number.isInteger(val)) {
      throw new Error('Invalid page number.');
    }
    if (!this.pdfDocument) {
      return;
    }
    // The intent can be to just reset a scroll position and/or scale.
    if (!this._setCurrentPageNumber(val, /* resetCurrentPageView = */ true)) {
      console.error(
        `${this._name}.currentPageNumber: "${val}" is not a valid page.`);
    }
  }

  /**
   * @return {boolean} Whether the pageNumber is valid (within bounds).
   * @private
   */
  _setCurrentPageNumber(val, resetCurrentPageView = false) {
    if (this._currentPageNumber === val) {
      if (resetCurrentPageView) {
        this._resetCurrentPageView();
      }
      return true;
    }

    if (!(0 < val && val <= this.pagesCount)) {
      return false;
    }
    this._currentPageNumber = val;

    this.eventBus.dispatch('pagechanging', {
      source: this,
      pageNumber: val,
      pageLabel: this._pageLabels && this._pageLabels[val - 1],
    });

    if (resetCurrentPageView) {
      this._resetCurrentPageView();
    }
    return true;
  }

  /**
   * @returns {string|null} Returns the current page label,
   *                        or `null` if no page labels exist.
   */
  get currentPageLabel() {
    return this._pageLabels && this._pageLabels[this._currentPageNumber - 1];
  }

  /**
   * @param {string} val - The page label.
   */
  set currentPageLabel(val) {
    if (!this.pdfDocument) {
      return;
    }
    let page = val | 0; // Fallback page number.
    if (this._pageLabels) {
      let i = this._pageLabels.indexOf(val);
      if (i >= 0) {
        page = i + 1;
      }
    }
    // The intent can be to just reset a scroll position and/or scale.
    if (!this._setCurrentPageNumber(page, /* resetCurrentPageView = */ true)) {
      console.error(
        `${this._name}.currentPageLabel: "${val}" is not a valid page.`);
    }
  }

  /**
   * @returns {number}
   */
  get currentScale() {
    return this._currentScale !== UNKNOWN_SCALE ? this._currentScale :
                                                  DEFAULT_SCALE;
  }

  /**
   * @param {number} val - Scale of the pages in percents.
   */
  set currentScale(val) {
    if (isNaN(val)) {
      throw new Error('Invalid numeric scale.');
    }
    if (!this.pdfDocument) {
      return;
    }
    this._setScale(val, false);
  }

  /**
   * @returns {string}
   */
  get currentScaleValue() {
    return this._currentScaleValue;
  }

  /**
   * @param val - The scale of the pages (in percent or predefined value).
   */
  set currentScaleValue(val) {
    if (!this.pdfDocument) {
      return;
    }
    this._setScale(val, false);
  }

  /**
   * @returns {number}
   */
  get pagesRotation() {
    return this._pagesRotation;
  }

  /**
   * @param {number} rotation - The rotation of the pages (0, 90, 180, 270).
   */
  set pagesRotation(rotation) {
    if (!isValidRotation(rotation)) {
      throw new Error('Invalid pages rotation angle.');
    }
    if (!this.pdfDocument) {
      return;
    }
    if (this._pagesRotation === rotation) {
      return; // The rotation didn't change.
    }
    this._pagesRotation = rotation;

    let pageNumber = this._currentPageNumber;

    for (let i = 0, ii = this._pages.length; i < ii; i++) {
      let pageView = this._pages[i];
      pageView.update(pageView.scale, rotation);
    }
    // The position needs to be recalculated when the page rotates.
    if (this._pages.length > 0) {
      this._pages[0].repositionAllPages();
    }
    // Prevent errors in case the rotation changes *before* the scale has been
    // set to a non-default value.
    if (this._currentScaleValue) {
      this._setScale(this._currentScaleValue, true);
    }

    this.eventBus.dispatch('rotationchanging', {
      source: this,
      pagesRotation: rotation,
      pageNumber,
    });

    if (this.defaultRenderingQueue) {
      this.update();
    }
  }

  get _setDocumentViewerElement() {
    // In most viewers, e.g. `PDFViewer`, this should return `this.viewer`.
    throw new Error('Not implemented: _setDocumentViewerElement');
  }

  /**
   * @param pdfDocument {PDFDocument}
   */
  setDocument(pdfDocument) {
    if (this.pdfDocument) {
      this._cancelRendering();
      this._resetView();

      if (this.findController) {
        this.findController.setDocument(null);
      }
    }

    this.pdfDocument = pdfDocument;
    if (!pdfDocument) {
      return;
    }
    let pagesCount = pdfDocument.numPages;

    let pagesCapability = createPromiseCapability();
    this.pagesPromise = pagesCapability.promise;

    pagesCapability.promise.then(() => {
      this._pageViewsReady = true;
      this.eventBus.dispatch('pagesloaded', {
        source: this,
        pagesCount,
      });
    });

    const onePageRenderedCapability = createPromiseCapability();
    this.onePageRendered = onePageRenderedCapability.promise;

    let bindOnAfterAndBeforeDraw = (pageView) => {
      pageView.onBeforeDraw = () => {
        // Add the page to the buffer at the start of drawing. That way it can
        // be evicted from the buffer and destroyed even if we pause its
        // rendering.
        // this._buffer.push(pageView);
      };
      pageView.onAfterDraw = () => {
        if (!onePageRenderedCapability.settled) {
          onePageRenderedCapability.resolve();
        }
      };
    };

    let firstPagePromise = pdfDocument.getPage(1);
    this.firstPagePromise = firstPagePromise;

    // Fetch a single page so we can get a viewport that will be the default
    // viewport for all pages
    firstPagePromise.then((pdfPage) => {
      let scale = this.currentScale;
      let viewport = pdfPage.getViewport({ scale: scale * CSS_UNITS, });
      for (let pageNum = 1; pageNum <= pagesCount; ++pageNum) {
        let textLayerFactory = null;
        if (this.textLayerMode !== TextLayerMode.DISABLE) {
          textLayerFactory = this;
        }
        let pageView = new PDFPageView({
          container: this._setDocumentViewerElement,
          eventBus: this.eventBus,
          id: pageNum,
          scale,
          defaultViewport: viewport.clone(),
          renderingQueue: this.renderingQueue,
          textLayerFactory,
          textLayerMode: this.textLayerMode,
          annotationLayerFactory: this,
          imageResourcesPath: this.imageResourcesPath,
          renderInteractiveForms: this.renderInteractiveForms,
          renderer: this.renderer,
          enableWebGL: this.enableWebGL,
          useOnlyCssZoom: this.useOnlyCssZoom,
          maxCanvasPixels: this.maxCanvasPixels,
          l10n: this.l10n,
          viewer: this,
        });
        bindOnAfterAndBeforeDraw(pageView);
        this._pages.push(pageView);
      }

      // Fetch all the pages since the viewport is needed before printing
      // starts to create the correct size canvas. Wait until one page is
      // rendered so we don't tie up too many resources early on.
      onePageRenderedCapability.promise.then(() => {
        window.PDFViewerApplication.appConfig.viewerLoading.
          style.display = 'none';
        if (pdfDocument.loadingParams['disableAutoFetch']) {
          // XXX: Printing is semi-broken with auto fetch disabled.
          pagesCapability.resolve();
          return;
        }
	// Here, the logo of whether the page has been loaded is stored to
	// facilitate the page to be loaded and recalculated once for all page
	// locations.
        this.getPagesLeft = pagesCount;
        for (let pageNum = 1; pageNum <= pagesCount; ++pageNum) {
          pdfDocument.getPage(pageNum).then((pdfPage) => {
            let pageView = this._pages[pageNum - 1];
            if (!pageView.pdfPage) {
              pageView.setPdfPage(pdfPage);
            }
            this.linkService.cachePageRef(pageNum, pdfPage.ref);
            if (--this.getPagesLeft === 0) {
              pagesCapability.resolve();
            }
          }, (reason) => {
            console.error(`Unable to get page ${pageNum} to initialize viewer`,
                          reason);
            if (--this.getPagesLeft === 0) {
              pagesCapability.resolve();
            }
          });
        }
      });

      this.eventBus.dispatch('pagesinit', { source: this, });

      if (this.findController) {
        this.findController.setDocument(pdfDocument); // Enable searching.
      }
      if (this.defaultRenderingQueue) {
        this.update();
      }
    }).catch((reason) => {
      console.error('Unable to initialize viewer', reason);
    });
  }

  /**
   * @param {Array|null} labels
   */
  setPageLabels(labels) {
    if (!this.pdfDocument) {
      return;
    }
    if (!labels) {
      this._pageLabels = null;
    } else if (!(Array.isArray(labels) &&
                 this.pdfDocument.numPages === labels.length)) {
      this._pageLabels = null;
      console.error(`${this._name}.setPageLabels: Invalid page labels.`);
    } else {
      this._pageLabels = labels;
    }
    // Update all the `PDFPageView` instances.
    for (let i = 0, ii = this._pages.length; i < ii; i++) {
      let pageView = this._pages[i];
      let label = this._pageLabels && this._pageLabels[i];
      pageView.setPageLabel(label);
    }
  }

  _resetView() {
    this._pages = [];
    this._currentPageNumber = 1;
    this._currentScale = UNKNOWN_SCALE;
    this._currentScaleValue = null;
    this._pageLabels = null;
    this._buffer = new PDFPageViewBuffer(DEFAULT_CACHE_SIZE, this);
    this._location = null;
    this._pagesRotation = 0;
    this._pagesRequests = [];
    this._pageViewsReady = false;
    this._scrollMode = ScrollMode.VERTICAL;
    this._spreadMode = SpreadMode.NONE;

    // Remove the pages from the DOM...
    this.viewer.textContent = '';
    // ... and reset the Scroll mode CSS class(es) afterwards.
    this._updateScrollMode();
  }

  _scrollUpdate() {
    if (this.pagesCount === 0) {
      return;
    }
    this.update();
  }

  _scrollIntoView({ pageView, pageSpot = null, pageNumber = null, }) {
    if (this.isInPresentationMode) {
      scrollIntoView(pageView.div, pageSpot);
    } else {
      util_scrollIntoView(pageView, pageSpot);
    }
  }

  _setScaleUpdatePages(newScale, newValue, noScroll = false, preset = false) {
    this._currentScaleValue = newValue.toString();

    if (isSameScale(this._currentScale, newScale)) {
      if (preset) {
        this.eventBus.dispatch('scalechanging', {
          source: this,
          scale: newScale,
          presetValue: newValue,
        });
      }
      return;
    }

    for (let i = 0, ii = this._pages.length; i < ii; i++) {
      this._pages[i].update(newScale);
    }
    this._currentScale = newScale;
    // Zooming in and out requires recalculating the page location.
    if (this._pages.length > 0) {
      this._pages[0].repositionAllPages();
    }
    if (!noScroll) {
      let page = this._currentPageNumber, dest;
      if (this._location &&
          !(this.isInPresentationMode || this.isChangingPresentationMode)) {
        page = this._location.pageNumber;
        dest = [null, { name: 'XYZ', }, this._location.left,
                this._location.top, null];
      }
      this.scrollPageIntoView({
        pageNumber: page,
        destArray: dest,
        allowNegativeOffset: true,
      });
    }

    this.eventBus.dispatch('scalechanging', {
      source: this,
      scale: newScale,
      presetValue: preset ? newValue : undefined,
    });

    if (this.defaultRenderingQueue) {
      this.update();
    }
  }

  _setScale(value, noScroll = false) {
    let scale = parseFloat(value);

    if (scale > 0) {
      this._setScaleUpdatePages(scale, value, noScroll, /* preset = */ false);
    } else {
      let currentPage = this._pages[this._currentPageNumber - 1];
      if (!currentPage) {
        return;
      }
      const noPadding = (this.isInPresentationMode || this.removePageBorders);
      let hPadding = noPadding ? 0 : SCROLLBAR_PADDING;
      let vPadding = noPadding ? 0 : VERTICAL_PADDING;

      if (!noPadding && this._isScrollModeHorizontal) {
        [hPadding, vPadding] = [vPadding, hPadding]; // Swap the padding values.
      }
      let pageWidthScale = (this.container.clientWidth - hPadding) /
                           currentPage.width * currentPage.scale;
      let pageHeightScale = (this.container.clientHeight - vPadding) /
                            currentPage.height * currentPage.scale;
      switch (value) {
        case 'page-actual':
          scale = 1;
          break;
        case 'page-width':
          scale = pageWidthScale;
          break;
        case 'page-height':
          scale = pageHeightScale;
          break;
        case 'page-fit':
          scale = Math.min(pageWidthScale, pageHeightScale);
          break;
        case 'auto':
          // For pages in landscape mode, fit the page height to the viewer
          // *unless* the page would thus become too wide to fit horizontally.
          let horizontalScale = isPortraitOrientation(currentPage) ?
            pageWidthScale : Math.min(pageHeightScale, pageWidthScale);
          scale = Math.min(MAX_AUTO_SCALE, horizontalScale);
          break;
        default:
          console.error(
            `${this._name}._setScale: "${value}" is an unknown zoom value.`);
          return;
      }
      this._setScaleUpdatePages(scale, value, noScroll, /* preset = */ true);
    }
  }

  /**
   * Refreshes page view: scrolls to the current page and updates the scale.
   * @private
   */
  _resetCurrentPageView() {
    if (this.isInPresentationMode) {
      // Fixes the case when PDF has different page sizes.
      this._setScale(this._currentScaleValue, true);
    }

    this._scrollIntoView({ pageView:
          this._pages[this._currentPageNumber - 1], });
  }

  /**
   * @typedef ScrollPageIntoViewParameters
   * @property {number} pageNumber - The page number.
   * @property {Array} destArray - (optional) The original PDF destination
   *   array, in the format: <page-ref> </XYZ|/FitXXX> <args..>
   * @property {boolean} allowNegativeOffset - (optional) Allow negative page
   *   offsets. The default value is `false`.
   */

  /**
   * Scrolls page into view.
   * @param {ScrollPageIntoViewParameters} params
   */
  scrollPageIntoView({ pageNumber, destArray = null,
                       allowNegativeOffset = false, }) {
    if (!this.pdfDocument) {
      return;
    }
    const pageView = (Number.isInteger(pageNumber) &&
                      this._pages[pageNumber - 1]);
    if (!pageView) {
      console.error(`${this._name}.scrollPageIntoView: ` +
        `"${pageNumber}" is not a valid pageNumber parameter.`);
      return;
    }

    if (this.isInPresentationMode || !destArray) {
      this._setCurrentPageNumber(pageNumber, /* resetCurrentPageView = */ true);
      return;
    }
    let x = 0, y = 0;
    let width = 0, height = 0, widthScale, heightScale;
    let changeOrientation = (pageView.rotation % 180 === 0 ? false : true);
    let pageWidth = (changeOrientation ? pageView.height : pageView.width) /
      pageView.scale / CSS_UNITS;
    let pageHeight = (changeOrientation ? pageView.width : pageView.height) /
      pageView.scale / CSS_UNITS;
    let scale = 0;
    switch (destArray[1].name) {
      case 'XYZ':
        x = destArray[2];
        y = destArray[3];
        scale = destArray[4];
        // If x and/or y coordinates are not supplied, default to
        // _top_ left of the page (not the obvious bottom left,
        // since aligning the bottom of the intended page with the
        // top of the window is rarely helpful).
        x = x !== null ? x : 0;
        y = y !== null ? y : pageHeight;
        break;
      case 'Fit':
      case 'FitB':
        scale = 'page-fit';
        break;
      case 'FitH':
      case 'FitBH':
        y = destArray[2];
        scale = 'page-width';
        // According to the PDF spec, section 12.3.2.2, a `null` value in the
        // parameter should maintain the position relative to the new page.
        if (y === null && this._location) {
          x = this._location.left;
          y = this._location.top;
        }
        break;
      case 'FitV':
      case 'FitBV':
        x = destArray[2];
        width = pageWidth;
        height = pageHeight;
        scale = 'page-height';
        break;
      case 'FitR':
        x = destArray[2];
        y = destArray[3];
        width = destArray[4] - x;
        height = destArray[5] - y;
        let hPadding = this.removePageBorders ? 0 : SCROLLBAR_PADDING;
        let vPadding = this.removePageBorders ? 0 : VERTICAL_PADDING;

        widthScale = (this.container.clientWidth - hPadding) /
          width / CSS_UNITS;
        heightScale = (this.container.clientHeight - vPadding) /
          height / CSS_UNITS;
        scale = Math.min(Math.abs(widthScale), Math.abs(heightScale));
        break;
      default:
        console.error(`${this._name}.scrollPageIntoView: ` +
          `"${destArray[1].name}" is not a valid destination type.`);
        return;
    }

    if (scale && scale !== this._currentScale) {
      this.currentScaleValue = scale;
    } else if (this._currentScale === UNKNOWN_SCALE) {
      this.currentScaleValue = DEFAULT_SCALE_VALUE;
    }

    if (scale === 'page-fit' && !destArray[4]) {
      this._scrollIntoView({
        pageView: pageView, // eslint-disable-line
        pageNumber,
      });
      return;
    }

    let boundingRect = [
      pageView.viewport.convertToViewportPoint(x, y),
      pageView.viewport.convertToViewportPoint(x + width, y + height)
    ];
    let left = Math.min(boundingRect[0][0], boundingRect[1][0]);
    let top = Math.min(boundingRect[0][1], boundingRect[1][1]);

    if (!allowNegativeOffset) {
      // Some bad PDF generators will create destinations with e.g. top values
      // that exceeds the page height. Ensure that offsets are not negative,
      // to prevent a previous page from becoming visible (fixes bug 874482).
      left = Math.max(left, 0);
      top = Math.max(top, 0);
    }
    this._scrollIntoView({
      pageView: pageView, // eslint-disable-line
      pageSpot: { left, top, },
      pageNumber,
    });
  }

  _updateLocation(firstPage) {
    let currentScale = this._currentScale;
    let currentScaleValue = this._currentScaleValue;
    let normalizedScaleValue =
      parseFloat(currentScaleValue) === currentScale ?
      Math.round(currentScale * 10000) / 100 : currentScaleValue;

    let pageNumber = firstPage.id;
    let pdfOpenParams = '#page=' + pageNumber;
    pdfOpenParams += '&zoom=' + normalizedScaleValue;
    let currentPageView = this._pages[pageNumber - 1];
    let container = this.container;
    let topLeft = currentPageView.getPagePoint(
      (container.scrollLeft - firstPage.x),
      (container.scrollTop - firstPage.y));
    let intLeft = Math.round(topLeft[0]);
    let intTop = Math.round(topLeft[1]);
    pdfOpenParams += ',' + intLeft + ',' + intTop;

    this._location = {
      pageNumber,
      scale: normalizedScaleValue,
      top: intTop,
      left: intLeft,
      rotation: this._pagesRotation,
      pdfOpenParams,
    };
  }

  _updateHelper(visiblePages) {
    throw new Error('Not implemented: _updateHelper');
  }

  update() {
    const visible = this._getVisiblePages();
    // Save the visual pages to compare whether the pages currently rendered
    // and to be rendered are visible.
    this.visiblePages = visible;

    const visiblePages = visible.views, numVisiblePages = visiblePages.length;

    // Terminate rendering tasks that are not visible.
    for (let i = 0; i < this.renderingCache.length; i++) {
      let exist = false;
      for (let j = 0; j < visiblePages.length; j++) {
        if (this.renderingCache[i].id == visiblePages[j].id) {
          exist = true;
          break;
        }
      }
      if (!exist) {
        this.renderingCache[i].cancelRendering();
      }
    }

    if (numVisiblePages === 0) {
      return;
    }
    const newCacheSize = Math.max(DEFAULT_CACHE_SIZE, 2 * numVisiblePages + 1);
    this._buffer.resize(newCacheSize, visiblePages);

    this.renderingQueue.renderHighestPriority(visible);

    this._updateHelper(visiblePages); // Run any class-specific update code.

    this._updateLocation(visible.first);
    this.eventBus.dispatch('updateviewarea', {
      source: this,
      location: this._location,
    });
  }

  containsElement(element) {
    return this.container.contains(element);
  }

  focus() {
    this.container.focus();
  }

  get _isScrollModeHorizontal() {
    // Used to ensure that pre-rendering of the next/previous page works
    // correctly, since Scroll/Spread modes are ignored in Presentation Mode.
    return (this.isInPresentationMode ?
            false : this._scrollMode === ScrollMode.HORIZONTAL);
  }

  get isInPresentationMode() {
    return this.presentationModeState === PresentationModeState.FULLSCREEN;
  }

  get isChangingPresentationMode() {
    return this.presentationModeState === PresentationModeState.CHANGING;
  }

  get isHorizontalScrollbarEnabled() {
    return (this.isInPresentationMode ?
      false : (this.container.scrollWidth > this.container.clientWidth));
  }

  get isVerticalScrollbarEnabled() {
    return (this.isInPresentationMode ?
      false : (this.container.scrollHeight > this.container.clientHeight));
  }

  /**
   * Helper method for `this._getVisiblePages`. Should only ever be used when
   * the viewer can only display a single page at a time, for example in:
   *  - `PDFSinglePageViewer`.
   *  - `PDFViewer` with Presentation Mode active.
   */
  _getCurrentVisiblePage() {
    if (!this.pagesCount) {
      return { views: [], };
    }
    const pageView = this._pages[this._currentPageNumber - 1];
    // NOTE: Compute the `x` and `y` properties of the current view,
    // since `this._updateLocation` depends of them being available.
    /* const element = pageView.div;

    const view = {
      id: pageView.id,
      x: element.offsetLeft + element.clientLeft,
      y: element.offsetTop + element.clientTop,
      view: pageView,
    }; */
    // Obtain the values of X and Y from the
    // calculated position information.
    const view = {
      id: pageView.id,
      x: getOffsetLeft(pageView),
      y: getOffsetTop(pageView),
      view: pageView,
    };
    return { first: view, last: view, views: [view], };
  }

  _getVisiblePages() {
    return util_getVisibleElements(this.viewer, this._pages, true,
                              this._isScrollModeHorizontal);
  }

  /**
   * @param {number} pageNumber
   */
  isPageVisible(pageNumber) {
    if (!this.pdfDocument) {
      return false;
    }
    if (this.pageNumber < 1 || pageNumber > this.pagesCount) {
      console.error(
        `${this._name}.isPageVisible: "${pageNumber}" is out of bounds.`);
      return false;
    }
    return this._getVisiblePages().views.some(function(view) {
      return (view.id === pageNumber);
    });
  }

  cleanup() {
    for (let i = 0, ii = this._pages.length; i < ii; i++) {
      if (this._pages[i] &&
          this._pages[i].renderingState !== RenderingStates.FINISHED) {
        this._pages[i].reset();
      }
    }
  }

  /**
   * @private
   */
  _cancelRendering() {
    for (let i = 0, ii = this._pages.length; i < ii; i++) {
      if (this._pages[i]) {
        this._pages[i].cancelRendering();
      }
    }
  }

  /**
   * @param {PDFPageView} pageView
   * @returns {Promise} Returns a promise containing a {PDFPageProxy} object.
   * @private
   */
  _ensurePdfPageLoaded(pageView) {
    if (pageView.pdfPage) {
      return Promise.resolve(pageView.pdfPage);
    }
    let pageNumber = pageView.id;
    if (this._pagesRequests[pageNumber]) {
      return this._pagesRequests[pageNumber];
    }
    let promise = this.pdfDocument.getPage(pageNumber).then((pdfPage) => {
      if (!pageView.pdfPage) {
        pageView.setPdfPage(pdfPage);
      }
      this._pagesRequests[pageNumber] = null;
      return pdfPage;
    }).catch((reason) => {
      console.error('Unable to get page for page view', reason);
      // Page error -- there is nothing can be done.
      this._pagesRequests[pageNumber] = null;
    });
    this._pagesRequests[pageNumber] = promise;
    return promise;
  }

  forceRendering(currentlyVisiblePages) {
    let visiblePages = currentlyVisiblePages || this._getVisiblePages();
    let scrollAhead = (this._isScrollModeHorizontal ?
                       this.scroll.right : this.scroll.down);
    // Add the visible page containers to the DOMTree before rendering
    // the page to show the loading status.
    this._addPageDivBySpreadMode(visiblePages, true);
    let pageView = this.renderingQueue.getHighestPriority(visiblePages,
                                                          this._pages,
                                                          scrollAhead);
    if (pageView) {
      this._ensurePdfPageLoaded(pageView).then(() => {
        this.renderingQueue.renderView(pageView, visiblePages);
      });
      return true;
    }
    return false;
  }

  /**
   * @param {HTMLDivElement} textLayerDiv
   * @param {number} pageIndex
   * @param {PageViewport} viewport
   * @returns {TextLayerBuilder}
   */
  createTextLayerBuilder(textLayerDiv, pageIndex, viewport,
                         enhanceTextSelection = false) {
    return new TextLayerBuilder({
      textLayerDiv,
      eventBus: this.eventBus,
      pageIndex,
      viewport,
      findController: this.isInPresentationMode ? null : this.findController,
      enhanceTextSelection: this.isInPresentationMode ? false :
                                                        enhanceTextSelection,
    });
  }

  /**
   * @param {HTMLDivElement} pageDiv
   * @param {PDFPage} pdfPage
   * @param {string} imageResourcesPath - (optional) Path for image resources,
   *   mainly for annotation icons. Include trailing slash.
   * @param {boolean} renderInteractiveForms
   * @param {IL10n} l10n
   * @returns {AnnotationLayerBuilder}
   */
  createAnnotationLayerBuilder(pageDiv, pdfPage, imageResourcesPath = '',
                               renderInteractiveForms = false,
                               l10n = NullL10n) {
    return new AnnotationLayerBuilder({
      pageDiv,
      pdfPage,
      imageResourcesPath,
      renderInteractiveForms,
      linkService: this.linkService,
      downloadManager: this.downloadManager,
      l10n,
    });
  }

  /**
   * @returns {boolean} Whether all pages of the PDF document have identical
   *                    widths and heights.
   */
  get hasEqualPageSizes() {
    let firstPageView = this._pages[0];
    for (let i = 1, ii = this._pages.length; i < ii; ++i) {
      let pageView = this._pages[i];
      if (pageView.width !== firstPageView.width ||
          pageView.height !== firstPageView.height) {
        return false;
      }
    }
    return true;
  }

  /**
   * Returns sizes of the pages.
   * @returns {Array} Array of objects with width/height/rotation fields.
   */
  getPagesOverview() {
    let pagesOverview = this._pages.map(function(pageView) {
      let viewport = pageView.pdfPage.getViewport({ scale: 1, });
      return {
        width: viewport.width,
        height: viewport.height,
        rotation: viewport.rotation,
      };
    });
    if (!this.enablePrintAutoRotate) {
      return pagesOverview;
    }
    let isFirstPagePortrait = isPortraitOrientation(pagesOverview[0]);
    return pagesOverview.map(function (size) {
      if (isFirstPagePortrait === isPortraitOrientation(size)) {
        return size;
      }
      return {
        width: size.height,
        height: size.width,
        rotation: (size.rotation + 90) % 360,
      };
    });
  }

  /**
   * @return {number} One of the values in {ScrollMode}.
   */
  get scrollMode() {
    return this._scrollMode;
  }

  /**
   * @param {number} mode - The direction in which the document pages should be
   *   laid out within the scrolling container.
   *   The constants from {ScrollMode} should be used.
   */
  set scrollMode(mode) {
    if (this._scrollMode === mode) {
      return; // The Scroll mode didn't change.
    }
    if (!isValidScrollMode(mode)) {
      throw new Error(`Invalid scroll mode: ${mode}`);
    }
    this._scrollMode = mode;
    this.eventBus.dispatch('scrollmodechanged', { source: this, mode, });

    this._updateScrollMode(/* pageNumber = */ this._currentPageNumber);
  }

  _updateScrollMode(pageNumber = null) {
    const scrollMode = this._scrollMode, viewer = this.viewer;

    viewer.classList.toggle('scrollHorizontal',
                            scrollMode === ScrollMode.HORIZONTAL);
    viewer.classList.toggle('scrollWrapped',
                            scrollMode === ScrollMode.WRAPPED);

    if (!this.pdfDocument || !pageNumber) {
      return;
    }

    // Horizontal scroll display using single page mode.
    if (scrollMode === ScrollMode.HORIZONTAL) {
      this._spreadMode = SpreadMode.NONE;
    }

    // Temporarily remove all the pages from the DOM.
    viewer.textContent = '';
    let pages = this._pages, maxI = pages.length;
    // Set whether the pages are added to the DOMTree as false.
    for (let i = 0; i < maxI; i++) {
      pages[i].isDivAddedToContainer = false;
    }
    // add the first and last page containers and reposition
    if (maxI > 0) {
      pages[0].repositionAllPages();
      this._addPageDivBySpreadMode({
        first: pages[0],
        last: pages[maxI - 1],
        views: [{ view: pages[0], }, { view: pages[maxI - 1], }],
      });
    }
    let visible = this._getVisiblePages();
    if (visible.views.length === 0) {
      visible = this._getCurrentVisiblePage();
    }
    this._addPageDivBySpreadMode(visible);
    // Non-numeric scale values can be sensitive to the scroll orientation.
    // Call this before re-scrolling to the current page, to ensure that any
    // changes in scale don't move the current page.
    if (this._currentScaleValue && isNaN(this._currentScaleValue)) {
      this._setScale(this._currentScaleValue, true);
    }
    this._setCurrentPageNumber(pageNumber, /* resetCurrentPageView = */ true);
    this.update();
  }

  /**
   * @return {number} One of the values in {SpreadMode}.
   */
  get spreadMode() {
    return this._spreadMode;
  }

  /**
   * @param {number} mode - Group the pages in spreads, starting with odd- or
   *   even-number pages (unless `SpreadMode.NONE` is used).
   *   The constants from {SpreadMode} should be used.
   */
  set spreadMode(mode) {
    if (this._spreadMode === mode) {
      return; // The Spread mode didn't change.
    }
    if (!isValidSpreadMode(mode)) {
      throw new Error(`Invalid spread mode: ${mode}`);
    }
    this._spreadMode = mode;
    this.eventBus.dispatch('spreadmodechanged', { source: this, mode, });

    this._updateSpreadMode(/* pageNumber = */ this._currentPageNumber);
  }

  _updateSpreadMode(pageNumber = null) {
    if (!this.pdfDocument) {
      return;
    }
    const viewer = this.viewer, pages = this._pages, maxI = pages.length;
    // Temporarily remove all the pages from the DOM.
    viewer.textContent = '';
    // Reset page status
    for (let i = 0; i < maxI; i++) {
      pages[i].isDivAddedToContainer = false;
    }
    // add the first and last page containers and reposition
    if (maxI > 0) {
      pages[0].repositionAllPages();
      this._addPageDivBySpreadMode({
        first: pages[0],
        last: pages[maxI - 1],
        views: [{ view: pages[0], }, { view: pages[maxI - 1], }],
      });
    }
    let visible = this._getVisiblePages();
    if (visible.views.length === 0) {
      visible = this._getCurrentVisiblePage();
    }
    this._addPageDivBySpreadMode(visible);
    if (!pageNumber) {
      return;
    }
    this._setCurrentPageNumber(pageNumber, /* resetCurrentPageView = */ true);
    this.update();
  }

  /**
   * [_addPageDivBySpreadMode Add div and spread according to
   * the presentation mode of the page]
   * @param {[type]} visiblePages [visiblePages]
   * @param {[type]} resetCss     [Do you need to reset the location style?]
   */
  _addPageDivBySpreadMode(visiblePages = null, resetCss) {
    if (!visiblePages.views.length) {
      return;
    }
    if (this._spreadMode === SpreadMode.NONE) { // Single page mode
      for (let i = 0; i < visiblePages.views.length; i++) {
        let view = visiblePages.views[i].view;
        if (resetCss) {
          view.div.style.top = view.position.realTop;
          view.div.style.left = view.position.realLeft;
        }
        if (!view.isDivAddedToContainer) {
          this.viewer.appendChild(view.div);
          view.isDivAddedToContainer = true;
          this._buffer.push(view);
        }
      }
    } else { // Double-page or book model
      for (let i = 0, iMax = visiblePages.views.length; i < iMax; ++i) {
        let view = visiblePages.views[i].view;
        if (!view.isDivAddedToContainer) {
          let spread = null;
          let pageIdx = view.id - 1;
          let _pages = this._pages;
          let pagesLen = this.pagesCount;
	  // Depending on whether the brothers page has joined the domtree,
	  // if it has joined, the parent node to the brothers node is
	  // spread, and if not, the spreads element needs to be rebuilt.
          if (pageIdx === 0) {
            if (_pages[1].position.spread.row === view.position.spread.row &&
                _pages[1].position.spread.column ===
                                      view.position.spread.column &&
                _pages[1].isDivAddedToContainer
                ) {
              spread = _pages[1].div.parentNode;
            }
          } else if (pageIdx === pagesLen - 1) {
            if (_pages[pageIdx - 1].position.spread.row ===
                          view.position.spread.row &&
                _pages[pageIdx - 1].position.spread.column ===
                          view.position.spread.column &&
                          _pages[pageIdx - 1].isDivAddedToContainer
                ) {
              spread = _pages[pageIdx - 1].div.parentNode;
            }
          } else {
            if (_pages[pageIdx - 1].position.spread.row ===
                              view.position.spread.row &&
                _pages[pageIdx - 1].position.spread.column ===
                                view.position.spread.column &&
                _pages[pageIdx - 1].isDivAddedToContainer
                ) {
              spread = _pages[pageIdx - 1].div.parentNode;
            } else if (_pages[pageIdx + 1].position.spread.row ===
                                  view.position.spread.row &&
                _pages[pageIdx + 1].position.spread.column ===
                                  view.position.spread.column &&
                _pages[pageIdx + 1].isDivAddedToContainer
                ) {
              spread = _pages[pageIdx + 1].div.parentNode;
            }
          }
          let isSpreadAdded = true;
          if (!spread) {
            isSpreadAdded = false;
            spread = document.createElement('div');
            spread.className = 'spread';
            spread.style.top = view.position.spread.realTop + 'px';
            spread.style.left = view.position.spread.realLeft + 'px';
          }
          let brotherPages = [_pages[pageIdx - 1], _pages[pageIdx + 1]];
          let insertPageDom = null;
          for (let j = 0; j < brotherPages.length; j++) {
            if (brotherPages[j] && brotherPages[j].position.spread.row ===
                      view.position.spread.row &&
                  brotherPages[j].position.spread.column ===
                  view.position.spread.column) {
              if (brotherPages[j].isDivAddedToContainer &&
                            view.id < brotherPages[j].id) {
                insertPageDom = brotherPages[j].div;
              }
            }
          }
          if (insertPageDom) {
            spread.insertBefore(view.div, insertPageDom);
          } else {
            spread.appendChild(view.div);
          }
          if (!isSpreadAdded) {
            this.viewer.appendChild(spread);
          }
          view.isDivAddedToContainer = true;
          this._buffer.push(view);
        } else if (resetCss) {
          view.div.parentNode.style.top = view.position.spread.realTop + 'px';
          view.div.parentNode.style.left = view.position.spread.realLeft + 'px';
        }
      }
    }
  }
}

export {
  BaseViewer,
};
