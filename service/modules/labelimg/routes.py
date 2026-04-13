from flask import Blueprint, render_template

labelimg_bp = Blueprint('labelimg', __name__)

@labelimg_bp.route('/labelimg')
def labelimg_page():
    return render_template('Labelimg.html')
