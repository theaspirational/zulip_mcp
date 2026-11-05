"""Offline Zulip 12.3 markdown_convert oracle. No renderer source is modified."""
import ast
import json
import os
from pathlib import Path
import re
import socket
import sys
import types
from dataclasses import dataclass

ROOT = Path(os.environ['ZULIP_SRC'])
sys.path.insert(0, str(ROOT))
# Defense in depth: all sockets are forbidden, including loopback.
def forbidden(*args, **kwargs):
    raise AssertionError('DB/network/unused service unexpectedly called')
socket.socket.connect = forbidden
socket.socket.connect_ex = forbidden
socket.create_connection = forbidden
from django.conf import settings
settings.configure(CAMO_URI='', ENABLE_FILE_LINKS=False, INLINE_URL_EMBED_PREVIEW=False,
                   INLINE_IMAGE_PREVIEW=False, MAX_MESSAGE_LENGTH=10_000_000,
                   INSTALLED_APPS=[], USE_TZ=True, SECRET_KEY='offline-oracle')


def stub(name, **attrs):
    module = types.ModuleType(name)
    module.__dict__.update(attrs)
    sys.modules[name] = module
    return module


# Read the real mention regexes and value classes without its DB import graph.
source = ast.parse((ROOT / 'zerver/lib/mention.py').read_text())
names = {'BEFORE_MENTION_ALLOWED_REGEX', 'BEFORE_LINK_PRODUCING_MENTION_ALLOWED_REGEX',
         'MENTIONS_RE', 'USER_GROUP_MENTIONS_RE', 'FullNameInfo', 'ChannelTopicInfo'}
nodes = [node for node in source.body if
         isinstance(node, ast.ClassDef) and node.name in names or
         isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id in names for t in node.targets)]
mentions = stub('zerver.lib.mention', re=re, dataclass=dataclass,
                MentionBackend=object, MentionData=object,
                get_user_group_mention_display_name=forbidden)
exec(compile(ast.Module(body=nodes, type_ignores=[]), '<real mention definitions>', 'exec'), mentions.__dict__)
stub('zerver.models', Message=type('Message', (), {}), Realm=type('Realm', (), {}),
     UserProfile=type('UserProfile', (), {}))
stub('zerver.models.linkifiers', linkifiers_for_realm=lambda key: [])
stub('zerver.models.realm_emoji', EmojiInfo=dict, get_name_keyed_dict_for_active_realm_emoji=forbidden)
# Model absent from sparse archive: stand-in language token grammar.
# Tested labels are plain ASCII words; delimiters/indentation are still real Zulip code.
stub('zerver.models.realm_playgrounds', PLAYGROUND_LANGUAGE_REGEX=r'[a-zA-Z0-9_+-]+')
stub('zerver.lib.camo', get_camo_url=forbidden)
stub('zerver.lib.emoji', EMOTICON_RE=r'(?!)', codepoint_to_name={}, name_to_codepoint={},
     translate_emoticons=forbidden)
stub('zerver.lib.exceptions', MarkdownRenderingError=type('MarkdownRenderingError', (Exception,), {}))
class NoNetworkSession:
    def __init__(self, *args, **kwargs):
        forbidden()
stub('zerver.lib.outgoing_http', OutgoingSession=NoNetworkSession)
stub('zerver.lib.subdomains', is_static_or_current_realm_url=lambda url: False)
stub('zerver.lib.tex', render_tex=lambda *args, **kwargs: None)
stub('zerver.lib.thumbnail', AttachmentData=object, manifest_and_get_user_upload_previews=forbidden,
     rewrite_thumbnailed_images=forbidden)
stub('zerver.lib.timeout', unsafe_timeout=lambda seconds, fn: fn())
stub('zerver.lib.timezone', common_timezones={})
stub('zerver.lib.topic_link_util', TOPIC_LINK_SYNTAX_FOR_DISPLAY='#{channel_name} > {topic_name}')
stub('zerver.lib.types', LinkifierDict=dict)
stub('zerver.lib.url_encoding', encode_channel=forbidden, encode_hash_component=forbidden)
from zerver.lib.markdown import markdown_convert
import markdown
assert markdown.__version__ == '3.10.3'

def render(content):
    return markdown_convert(content, no_previews=True).rendered_content

if __name__ == '__main__':
    for line in sys.stdin:
        case = json.loads(line)
        print(json.dumps({'input': case, 'html': render(case)}, ensure_ascii=False))
