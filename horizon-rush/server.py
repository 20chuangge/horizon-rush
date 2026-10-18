#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Horizon Rush · 本地静态服务器（可选）
用法：python server.py [端口，默认 8080]
然后浏览器打开 http://127.0.0.1:8080/
双击 index.html 也可以直接玩，本脚本只是为浏览器限制 file:// 时准备的。
"""
import http.server
import socketserver
import sys
import os

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
os.chdir(os.path.dirname(os.path.abspath(__file__)))


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, fmt, *args):
        pass


if __name__ == '__main__':
    try:
        with socketserver.TCPServer(('127.0.0.1', PORT), Handler) as httpd:
            print('Horizon Rush 已启动: http://127.0.0.1:%d/' % PORT)
            print('按 Ctrl+C 停止。')
            httpd.serve_forever()
    except OSError as e:
        print('端口 %d 启动失败（可能被占用）：%s' % (PORT, e))
        print('可尝试：python server.py 8081')
        input('按回车退出...')
