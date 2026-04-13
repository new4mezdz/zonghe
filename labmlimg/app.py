import webview
import os
import sys
import base64

class Api:
    def __init__(self):
        self.image_folder = None
        self.output_folder = None
        self._window = None

    def set_window(self, w):
        self._window = w

    def select_image_folder(self):
        result = self._window.create_file_dialog(webview.FOLDER_DIALOG)
        if result and len(result) > 0:
            self.image_folder = result[0]
            exts = ('.jpg', '.jpeg', '.png', '.bmp', '.webp', '.gif')
            files = sorted([
                f for f in os.listdir(self.image_folder)
                if os.path.splitext(f)[1].lower() in exts
            ])
            return {'folder': self.image_folder, 'files': files}
        return None

    def select_output_folder(self):
        result = self._window.create_file_dialog(webview.FOLDER_DIALOG)
        if result and len(result) > 0:
            self.output_folder = result[0]
            return self.output_folder
        return None

    def load_image(self, filename):
        if not self.image_folder:
            return None
        path = os.path.join(self.image_folder, filename)
        if not os.path.exists(path):
            return None
        with open(path, 'rb') as f:
            data = base64.b64encode(f.read()).decode('utf-8')
        ext = os.path.splitext(filename)[1].lower().lstrip('.')
        mime_map = {
            'jpg': 'image/jpeg', 'jpeg': 'image/jpeg',
            'png': 'image/png', 'bmp': 'image/bmp',
            'gif': 'image/gif', 'webp': 'image/webp'
        }
        mime = mime_map.get(ext, 'image/jpeg')
        return f'data:{mime};base64,{data}'

    def save_file(self, filename, content):
        folder = self.output_folder or self.image_folder
        if not folder:
            return False
        path = os.path.join(folder, filename)
        with open(path, 'w', encoding='utf-8') as f:
            f.write(content)
        return True

    def get_output_folder(self):
        return self.output_folder or self.image_folder or ''


def get_resource_path(filename):
    if getattr(sys, 'frozen', False):
        base = sys._MEIPASS
    else:
        base = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(base, filename)


if __name__ == '__main__':
    api = Api()
    html_path = get_resource_path('Labelimg.html')
    window = webview.create_window(
        '图片标注工具 - LabelImg',
        url=html_path,
        width=1280,
        height=800,
        min_size=(900, 600),
        js_api=api
    )
    api.set_window(window)
    webview.start()