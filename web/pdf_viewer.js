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
// ----------------------------- tanglinhai start ------------------------------
import { getOffsetLeft } from './ui_utils.js';
// ----------------------------- tanglinhai end ------------------------------
import { BaseViewer } from "./base_viewer.js";
import { shadow } from "pdfjs-lib";

class PDFViewer extends BaseViewer {
  get _viewerElement() {
    return shadow(this, "_viewerElement", this.viewer);
  }

  // ----------------------------- tanglinhai start ------------------------------
  _scrollIntoView({ pageView, pageSpot = null, pageNumber = null, }) {
  // ----------------------------- tanglinhai end ------------------------------
    if (!pageSpot && !this.isInPresentationMode) {
      // ----------------------------- tanglinhai start ------------------------------
      const pageDiv = pageView.div;
      const left = getOffsetLeft(pageView);
      const right = left + pageView.position.width;
      /*const left = pageDiv.offsetLeft + pageDiv.clientLeft;
      const right = left + pageDiv.clientWidth;*/
      // ----------------------------- tanglinhai end ------------------------------
      const { scrollLeft, clientWidth, } = this.viewer;
      if (this._isScrollModeHorizontal ||
          left < scrollLeft || right > scrollLeft + clientWidth) {
        pageSpot = { left: 0, top: 0, };
      }
    }
    // ----------------------------- tanglinhai start ------------------------------
    super._scrollIntoView({ pageView, pageSpot, pageNumber, });
    // ----------------------------- tanglinhai end ------------------------------
  }

  _getVisiblePages() {
    if (this.isInPresentationMode) {
      // The algorithm in `getVisibleElements` doesn't work in all browsers and
      // configurations (e.g. Chrome) when Presentation Mode is active.
      return this._getCurrentVisiblePage();
    }
    return super._getVisiblePages();
  }

  _updateHelper(visiblePages) {
    if (this.isInPresentationMode) {
      return;
    }
    let currentId = this._currentPageNumber;
    let stillFullyVisible = false;

    for (const page of visiblePages) {
      // ----------------------------- tanglinhai start -----------------------------
      if (page.view.percent < 100) {
      // ----------------------------- tanglinhai end -----------------------------
        break;
      }
      // ----------------------------- tanglinhai start -----------------------------
      if (page.view.id === currentId) {
      // ----------------------------- tanglinhai end -----------------------------
        stillFullyVisible = true;
        break;
      }
    }
    if (!stillFullyVisible) {
      // ----------------------------- tanglinhai start -----------------------------
      currentId = visiblePages.length > 0 ? visiblePages[0].view.id : 1;
      // ----------------------------- tanglinhai end -----------------------------
    }
    this._setCurrentPageNumber(currentId);
  }
}

export { PDFViewer };
