"""
Vercel serverless Python function — esegue codice excel_builder e ritorna azioni JSON.
Endpoint: POST /api/codefirst/execute
"""
import json
import sys
import io
import math as _math


class _SheetBuffer:
    def __init__(self, name):
        self.name = name
        self.cells = {}
        self.dirty = False

    def set_cell(self, addr, value=None, formula=None, note=None, bold=False,
                 italic=False, fontSize=None, numberFormat=None, fill=None,
                 fontColor=None, alignment=None, border=None):
        c = {}
        if value is not None: c['value'] = value
        if formula is not None: c['formula'] = formula
        if note is not None: c['note'] = note
        styles = {}
        if bold: styles['bold'] = True
        if italic: styles['italic'] = True
        if fontSize is not None: styles['fontSize'] = fontSize
        if numberFormat is not None: styles['numberFormat'] = numberFormat
        if fill is not None: styles['fill'] = fill
        if fontColor is not None: styles['fontColor'] = fontColor
        if alignment is not None: styles['alignment'] = alignment
        if border is not None: styles['border'] = border
        if styles: c['cellStyles'] = styles
        self.cells[addr] = c
        self.dirty = True

    def flush(self):
        if not self.dirty or not self.cells: return None
        action = {'type': 'setCellRange', 'sheet': self.name, 'cells': dict(self.cells)}
        self.cells.clear()
        self.dirty = False
        return action

    def size(self):
        return len(self.cells)


class Workbook:
    def __init__(self, out):
        self._buffers = {}
        self._out = out
        self._sheet_names = []

    def create_sheet(self, name):
        self._out.append({'type': 'createSheet', 'sheet': name})
        self._sheet_names.append(name)
        if name not in self._buffers:
            self._buffers[name] = _SheetBuffer(name)

    def _get_or_create_buffer(self, sheet_name):
        if sheet_name not in self._buffers:
            self._buffers[sheet_name] = _SheetBuffer(sheet_name)
        return self._buffers[sheet_name]

    def _maybe_flush(self, except_sheet=None, force=False):
        for name, buf in list(self._buffers.items()):
            if name == except_sheet: continue
            if force or buf.size() >= 120:
                a = buf.flush()
                if a: self._out.append(a)

    def write(self, sheet_name, cells_dict):
        self._maybe_flush(except_sheet=sheet_name)
        buf = self._get_or_create_buffer(sheet_name)
        for addr, props in cells_dict.items():
            if isinstance(props, (int, float, str)):
                buf.set_cell(addr, value=props)
            elif isinstance(props, dict):
                buf.set_cell(addr, **props)

    def write_range(self, sheet_name, start_addr, data_2d):
        self._maybe_flush(except_sheet=sheet_name)
        buf = self._get_or_create_buffer(sheet_name)
        sc, sr = _parse_addr(start_addr)
        for ri, row in enumerate(data_2d):
            if not isinstance(row, (list, tuple)): row = [row]
            for ci, val in enumerate(row):
                addr = _make_addr(sc + ci, sr + ri)
                if isinstance(val, dict): buf.set_cell(addr, **val)
                else: buf.set_cell(addr, value=val)

    def fill(self, sheet_name, start_addr, end_addr, formula=None, value=None):
        self._maybe_flush(except_sheet=None, force=True)
        a = {'type': 'fillRange', 'sheet': sheet_name, 'start': start_addr, 'end': end_addr}
        if formula is not None: a['formula'] = formula
        if value is not None: a['value'] = value
        self._out.append(a)

    def format(self, sheet_name, range_addr, format_dict):
        self._maybe_flush(except_sheet=None, force=True)
        self._out.append({'type': 'bulk_set_format', 'sheet': sheet_name,
                          'range': range_addr, 'format': format_dict})

    def finalize(self):
        self._maybe_flush(force=True)


def _parse_addr(addr):
    col_str, row_str = '', ''
    for ch in addr.upper():
        if ch.isalpha(): col_str += ch
        else: row_str += ch
    col = 0
    for ch in col_str:
        col = col * 26 + (ord(ch) - ord('A') + 1)
    return col, int(row_str or '1')


def _make_addr(col, row):
    c, s = col, ''
    while c > 0:
        c, rem = divmod(c - 1, 26)
        s = chr(ord('A') + rem) + s
    return f'{s}{row}'


HEADER_FILL = '#1F4E79'; HEADER_FONT = '#FFFFFF'
SECTION_FILL = '#D6E4F0'; NUMBER_FILL = '#F2F2F2'
HDR_BG = '#1F4E79'; HDR_FG = '#FFFFFF'
INP_BG = '#FFF2CC'; FML_BG = '#DAEEF3'
SEC_BG = '#D6E4F0'; TOT_BG = '#E2EFDA'


def _build_globals(out_list):
    wb = Workbook(out_list)

    def _create_sheet(name): wb.create_sheet(name)
    def _write(sheet_name, cells_dict): wb.write(sheet_name, cells_dict)
    def _write_range(sheet_name, start_addr, data_2d): wb.write_range(sheet_name, start_addr, data_2d)
    def _fill(sheet_name, start_addr, end_addr, formula=None, value=None): wb.fill(sheet_name, start_addr, end_addr, formula=formula, value=value)
    def _format(sheet_name, range_addr, format_dict): wb.format(sheet_name, range_addr, format_dict)
    def _finalize(): wb.finalize()
    def _set_column_width(sheet_name, column_letter, width): pass
    def _set_row_height(sheet_name, row_number, height): pass

    return {
        'create_sheet': _create_sheet, 'write': _write,
        'write_range': _write_range, 'fill': _fill,
        'format': _format, 'finalize': _finalize,
        'set_column_width': _set_column_width, 'set_row_height': _set_row_height,
        'Workbook': Workbook,
        'HEADER_FILL': HEADER_FILL, 'HEADER_FONT': HEADER_FONT,
        'SECTION_FILL': SECTION_FILL, 'NUMBER_FILL': NUMBER_FILL,
        'HDR_BG': HDR_BG, 'HDR_FG': HDR_FG,
        'INP_BG': INP_BG, 'FML_BG': FML_BG,
        'SEC_BG': SEC_BG, 'TOT_BG': TOT_BG,
        'math': _math,
        'range': range, 'enumerate': enumerate,
        'int': int, 'float': float, 'str': str, 'bool': bool,
        'list': list, 'dict': dict, 'tuple': tuple, 'set': set,
        'len': len, 'sum': sum, 'min': min, 'max': max,
        'abs': abs, 'round': round, 'chr': chr, 'ord': ord,
        'print': lambda *a, **kw: None,
        '__builtins__': {
            'range': range, 'enumerate': enumerate,
            'int': int, 'float': float, 'str': str, 'bool': bool,
            'list': list, 'dict': dict, 'tuple': tuple, 'set': set,
            'len': len, 'sum': sum, 'min': min, 'max': max,
            'abs': abs, 'round': round, 'chr': chr, 'ord': ord,
            'print': lambda *a, **kw: None,
            'True': True, 'False': False, 'None': None,
        }
    }


def execute_code(code):
    out = []
    globs = _build_globals(out)
    exec(code, globs)
    return out


# ── WSGI handler (Vercel @vercel/python standard) ──

def handler(environ, start_response):
    method = environ.get('REQUEST_METHOD', 'GET')

    if method != 'POST':
        start_response('405 Method Not Allowed', [('Content-Type', 'application/json')])
        return [json.dumps({'error': 'Only POST allowed'}).encode('utf-8')]

    try:
        content_length = int(environ.get('CONTENT_LENGTH', 0))
        body_raw = environ.get('wsgi.input', sys.stdin).read(content_length) if content_length > 0 else b'{}'
        body = json.loads(body_raw.decode('utf-8'))
        code = body.get('code', '')

        if not code:
            start_response('400 Bad Request', [('Content-Type', 'application/json')])
            return [json.dumps({'error': 'Missing "code" field'}).encode('utf-8')]

        if len(code) > 50000:
            start_response('400 Bad Request', [('Content-Type', 'application/json')])
            return [json.dumps({'error': 'Code too long (max 50000 chars)'}).encode('utf-8')]

        actions = execute_code(code)
        start_response('200 OK', [('Content-Type', 'application/json')])
        return [json.dumps({'actions': actions, 'count': len(actions)}, ensure_ascii=False).encode('utf-8')]

    except Exception as e:
        start_response('500 Internal Server Error', [('Content-Type', 'application/json')])
        return [json.dumps({'error': str(e), 'type': type(e).__name__}).encode('utf-8')]
