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

const CLEANUP_TIMEOUT = 30000;

const RenderingStates = {
  INITIAL: 0,
  RUNNING: 1,
  PAUSED: 2,
  FINISHED: 3,
};

/**
 * Controls rendering of the views for pages and thumbnails.
 */
class PDFRenderingQueue {
  constructor() {
    this.pdfViewer = null;
    this.pdfThumbnailViewer = null;
    this.onIdle = null;
    this.highestPriorityPage = null;
    this.idleTimeout = null;
    this.printing = false;
    this.isThumbnailViewEnabled = false;
  }

  /**
   * @param {PDFViewer} pdfViewer
   */
  setViewer(pdfViewer) {
    this.pdfViewer = pdfViewer;
  }

  /**
   * @param {PDFThumbnailViewer} pdfThumbnailViewer
   */
  setThumbnailViewer(pdfThumbnailViewer) {
    this.pdfThumbnailViewer = pdfThumbnailViewer;
  }

  /**
   * @param {IRenderableView} view
   * @returns {boolean}
   */
  isHighestPriority(view) {
    return this.highestPriorityPage === view.renderingId;
  }

  /**
   * @param {Object} currentlyVisiblePages
   * @param {Boolean} reInitPageContainer When updating, you need to
   * set up a page container.
   */
  /* ---------------------------------- tanglinhai start ------------------------------------ */
  renderHighestPriority(currentlyVisiblePages, reInitPageContainer) {
  /* ---------------------------------- tanglinhai end ------------------------------------ */
    if (this.idleTimeout) {
      clearTimeout(this.idleTimeout);
      this.idleTimeout = null;
    }
    // Pages have a higher priority than thumbnails, so check them first.
    /* ---------------------------------- tanglinhai start ------------------------------------ */
    if (this.pdfViewer.forceRendering(currentlyVisiblePages, reInitPageContainer)) {
    /* ---------------------------------- tanglinhai end ------------------------------------ */
      return;
    }
    // No pages needed rendering, so check thumbnails.
    if (this.pdfThumbnailViewer && this.isThumbnailViewEnabled) {
      if (this.pdfThumbnailViewer.forceRendering()) {
        return;
      }
    }

    if (this.printing) {
      // If printing is currently ongoing do not reschedule cleanup.
      return;
    }

    if (this.onIdle) {
      this.idleTimeout = setTimeout(this.onIdle.bind(this), CLEANUP_TIMEOUT);
    }
  }

  /**
   * @param {Object} visible
   * @param {Array} views
   * @param {boolean} scrolledDown
   */
  getHighestPriority(visible, views, scrolledDown) {
    /**
     * The state has changed. Figure out which page has the highest priority to
     * render next (if any).
     *
     * Priority:
     * 1. visible pages
     * 2. if last scrolled down, the page after the visible pages, or
     *    if last scrolled up, the page before the visible pages
     */
    const visibleViews = visible.views;

    const numVisible = visibleViews.length;
    if (numVisible === 0) {
      return null;
    }
    for (let i = 0; i < numVisible; ++i) {
      const view = visibleViews[i].view;
      if (!this.isViewFinished(view)) {
        return view;
      }
    }
    // ------------------------------ tanglinhai start ---------------------------------
    // 当可见部分渲染完毕之后，继续渲染距离最近可视部分的页面，这个不需要影响性能，关闭
    // All the visible views have rendered; try to render next/previous pages.
    /* if (scrolledDown) {
      const nextPageIndex = visible.last.id;
      // IDs start at 1, so no need to add 1.
      if (views[nextPageIndex] && !this.isViewFinished(views[nextPageIndex])) {
        return views[nextPageIndex];
      }
    } else {
      const previousPageIndex = visible.first.id - 2;
      if (
        views[previousPageIndex] &&
        !this.isViewFinished(views[previousPageIndex])
      ) {
        return views[previousPageIndex];
      }
    } */
    // ------------------------------ tanglinhai end ---------------------------------
    // Everything that needs to be rendered has been.
    return null;
  }

  /**
   * @param {IRenderableView} view
   * @returns {boolean}
   */
  isViewFinished(view) {
    return view.renderingState === RenderingStates.FINISHED;
  }

  /**
   * Render a page or thumbnail view. This calls the appropriate function
   * based on the views state. If the view is already rendered it will return
   * `false`.
   *
   * @param {IRenderableView} view
     ---------------------------------- tanglinhai start ------------------------------------
   * @param {
   *    id: view.id,
   *    x: pageLeft,
   *    y: pageTop,
   *    view{PDFPageView},
   *    percent,
   *  } visiblePages
     ---------------------------------- tanglinhai end ------------------------------------
   */
  /* ---------------------------------- tanglinhai start ------------------------------------ */
  renderView(view/*, visiblePages*/) {
  /* ---------------------------------- tanglinhai end ------------------------------------ */
    switch (view.renderingState) {
      case RenderingStates.FINISHED:
        return false;
      case RenderingStates.PAUSED:
        this.highestPriorityPage = view.renderingId;
        view.resume();
        break;
      case RenderingStates.RUNNING:
        this.highestPriorityPage = view.renderingId;
        break;
      case RenderingStates.INITIAL:
        this.highestPriorityPage = view.renderingId;
        // ----------------------------- tanglinhai start ------------------------------
        // Caching pages being rendered.
        /*if (visiblePages) {
          view.viewer.renderingCache.push(view);
        }*/
        view.draw().finally(() => {
          // render pages
          /*if (visiblePages) {
            // Stop rendering pages in the last scroll visual area.
            if (view.viewer.visiblePagesCache.indexOf(visiblePages) === -1) {
              console.log('==============stop rendering pages in the last scroll visual area. ==============', view);
              return;
            }
            // Pages rendered are deleted from the cache.
            view.viewer.renderingCache.splice(view.viewer.renderingCache.indexOf(view), 1);
            const visibles = visiblePages.views;
            // Remove rendered page.
            for (let i = 0; i < visibles.length; i++) {
              if (view.id === visibles[i].id) {
                visibles.splice(i, 1);
                break;
              }
            }
            // All pages are rendered.
            if (visibles.length === 0) {
              console.log('=================All pages are rendered.================');
              return;
            }
            visiblePages.first = visibles[0];
            visiblePages.last = visibles[visibles.length - 1];
            const first = visibles[0], last = visibles[visibles.length - 1];
            this.renderHighestPriority(visiblePages);
          }*/
          this.renderHighestPriority();
        }).catch(reason => {
          if (reason instanceof RenderingCancelledException) {
            return;
          }
          console.error(`renderView: "${reason}"`);
        });

        /*view.draw().finally(() => {
            this.renderHighestPriority();
          }).catch(reason => {
            console.error(`renderView: "${reason}"`);
          });*/
        // ----------------------------- tanglinhai end ------------------------------
        break;
    }
    return true;
  }
}

export { RenderingStates, PDFRenderingQueue };
