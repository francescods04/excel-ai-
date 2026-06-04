"""
excel_builder — DSL Python per costruire fogli Excel.
Ogni operazione emette una action JSON su stdout.
Il bridge Node.js legge le linee e le streamma via SSE.
"""
import json
import sys


class _SheetBuffer:
    def __init__(self, name):
        self.name = name
        self.cells = {}
        self.dirty = False

    def set_cell(self, addr, value=None, formula=None, note=None, bold=False,
                 italic=False, fontSize=None, numberFormat=None, fill=None,
                 fontColor=None, alignment=None, border=None):
        c = {}
        if value is not None:
            c['value'] = value
        if formula is not None:
            c['formula'] = formula
        if note is not None:
            c['note'] = note
        styles = {}
        if bold:
            styles['bold'] = True
        if italic:
            styles['italic'] = True
        if fontSize is not None:
            styles['fontSize'] = fontSize
        if numberFormat is not None:
            styles['numberFormat'] = numberFormat
        if fill is not None:
            styles['fill'] = fill
        if fontColor is not None:
            styles['fontColor'] = fontColor
        if alignment is not None:
            styles['alignment'] = alignment
        if border is not None:
            styles['border'] = border
        if styles:
            c['cellStyles'] = styles
        self.cells[addr] = c
        self.dirty = True

    def flush(self):
        if not self.dirty or not self.cells:
            return None
        action = {
            'type': 'setCellRange',
            'sheet': self.name,
            'cells': dict(self.cells)
        }
        self.cells.clear()
        self.dirty = False
        return action

    def size(self):
        return len(self.cells)


class Workbook:
    def __init__(self):
        self._buffers = {}       # sheet_name -> _SheetBuffer
        self._current_sheet = None
        self._action_count = 0
        self._sheet_names = []

    def create_sheet(self, name):
        action = {'type': 'createSheet', 'sheet': name}
        self._emit(action)
        self._sheet_names.append(name)
        self._current_sheet = name
        if name not in self._buffers:
            self._buffers[name] = _SheetBuffer(name)

    def _get_or_create_buffer(self, sheet_name):
        if sheet_name not in self._buffers:
            self._buffers[sheet_name] = _SheetBuffer(sheet_name)
        return self._buffers[sheet_name]

    def _maybe_flush(self, except_sheet=None, force=False):
        for name, buf in list(self._buffers.items()):
            if name == except_sheet:
                continue
            if force or buf.size() >= 120:
                action = buf.flush()
                if action:
                    self._emit(action)

    def write(self, sheet_name, cells_dict):
        self._maybe_flush(except_sheet=sheet_name)
        buf = self._get_or_create_buffer(sheet_name)
        for addr, props in cells_dict.items():
            if isinstance(props, (int, float, str)):
                buf.set_cell(addr, value=props)
            elif isinstance(props, dict):
                buf.set_cell(addr, **props)
        self._current_sheet = sheet_name

    def write_range(self, sheet_name, start_addr, data_2d):
        self._maybe_flush(except_sheet=sheet_name)
        buf = self._get_or_create_buffer(sheet_name)
        start_col, start_row = _parse_addr(start_addr)
        for ri, row in enumerate(data_2d):
            if not isinstance(row, (list, tuple)):
                row = [row]
            for ci, val in enumerate(row):
                addr = _make_addr(start_col + ci, start_row + ri)
                if isinstance(val, dict):
                    buf.set_cell(addr, **val)
                else:
                    buf.set_cell(addr, value=val)
        self._current_sheet = sheet_name

    def fill(self, sheet_name, start_addr, end_addr, formula=None, value=None):
        self._maybe_flush(except_sheet=None, force=True)
        action = {'type': 'fillRange', 'sheet': sheet_name,
                  'start': start_addr, 'end': end_addr}
        if formula is not None:
            action['formula'] = formula
        if value is not None:
            action['value'] = value
        self._emit(action)
        self._current_sheet = sheet_name

    def format(self, sheet_name, range_addr, format_dict):
        self._maybe_flush(except_sheet=None, force=True)
        action = {'type': 'bulk_set_format', 'sheet': sheet_name,
                  'range': range_addr, 'format': format_dict}
        self._emit(action)
        self._current_sheet = sheet_name

    def finalize(self):
        self._maybe_flush(force=True)

    def _emit(self, action):
        self._action_count += 1
        line = json.dumps(action, ensure_ascii=False)
        sys.stdout.write(line + '\n')
        sys.stdout.flush()


def _parse_addr(addr):
    col_str = ''
    row_str = ''
    for ch in addr.upper():
        if ch.isalpha():
            col_str += ch
        else:
            row_str += ch
    col = 0
    for ch in col_str:
        col = col * 26 + (ord(ch) - ord('A') + 1)
    return col, int(row_str or '1')


def _make_addr(col, row):
    col_str = ''
    c = col
    while c > 0:
        c, rem = divmod(c - 1, 26)
        col_str = chr(ord('A') + rem) + col_str
    return f'{col_str}{row}'


def _col_letter(col_zero_based):
    c = col_zero_based + 1
    s = ''
    while c > 0:
        c, rem = divmod(c - 1, 26)
        s = chr(ord('A') + rem) + s
    return s


# ── Module-level convenience ──

_builder = None


def workbook():
    global _builder
    if _builder is None:
        _builder = Workbook()
    return _builder


# Shortcuts
def create_sheet(name):
    wb = workbook()
    wb.create_sheet(name)


def write(sheet_name, cells_dict):
    wb = workbook()
    wb.write(sheet_name, cells_dict)


def write_range(sheet_name, start_addr, data_2d):
    wb = workbook()
    wb.write_range(sheet_name, start_addr, data_2d)


def fill(sheet_name, start_addr, end_addr, formula=None, value=None):
    wb = workbook()
    wb.fill(sheet_name, start_addr, end_addr, formula=formula, value=value)


def format(sheet_name, range_addr, format_dict):
    wb = workbook()
    wb.format(sheet_name, range_addr, format_dict)


def finalize():
    wb = workbook()
    wb.finalize()


def set_column_width(sheet_name, column_letter, width):
    pass


def set_row_height(sheet_name, row_number, height):
    pass


# Colors — legacy names
HEADER_FILL = '#1F4E79'
HEADER_FONT = '#FFFFFF'
SECTION_FILL = '#D6E4F0'
NUMBER_FILL = '#F2F2F2'
BORDER_THIN = 'thin'

# Colors — new standard names (preferred)
HDR_BG = '#1F4E79'
HDR_FG = '#FFFFFF'
INP_BG = '#FFF2CC'
FML_BG = '#DAEEF3'
SEC_BG = '#D6E4F0'
TOT_BG = '#E2EFDA'
